/**
 * Pi telemetry wiring for the Doom harness.
 *
 * This extension deliberately emits metadata-only records. Prompt, message,
 * tool payload, file path, diagnostic text, exception, and stack data never
 * cross the shared telemetry boundary.
 */

import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  type DoomReadinessCoordinator,
  readDoomReadinessCoordinator,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import {
  DOOM_UI_HUB_SERVICE,
  type DoomUiHubService,
  requireDoomUiHub,
} from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { createDoomTelemetry, type DoomTelemetry, type DoomTelemetryOptions } from '@agimon-ai/doompi-telemetry';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from '@earendil-works/pi-coding-agent';
import { LogMetricsAggregator, type LogMetricsRecorder } from '../../services/metrics.ts';
import { LogMetricsOverlayComponent, type LogMetricsView, type SinkStatus } from '../../tui/logMetricsOverlay.ts';
import type { MetricsQuery, MetricsSource } from '../../types/metricsSource.ts';
import { createMetricsSource } from '../node/metricsSource.ts';

const SERVICE_NAME = 'pi';
const PACKAGE_NAME = '@agimon-ai/doompi-log';
/** Opt back into stderr diagnostics when debugging outside a live TUI. */
const DIAGNOSTICS_STDERR = 'stderr';
const LEADER_SOURCE = '@agimon-ai/doompi-log';
const LOG_METRICS_COMMAND = 'log-metrics';
const LOG_METRICS_DESCRIPTION = 'Show session-local log metrics';
const HELP_GROUP_ORDER = 70;
/** Must match the Help group published by doompi-ui, or the registry drops this. */
const HELP_GROUP_DETAIL = 'package docs and logs';
const NO_ENDPOINT = 'none';
const API_ERROR_STATUS = 400;
const FAILURE_STOP_REASONS = new Set(['error', 'aborted']);

type TelemetryFactory = NonNullable<DoomTelemetryOptions['telemetryFactory']>;
type TelemetryAttributes = Record<string, string | number | boolean>;
type RecordLevel = 'debug' | 'info' | 'warn' | 'error';

export interface PiTelemetryExtensionOptions {
  allowFileFallback?: boolean;
  /** Overrides the telemetry service identity. */
  serviceName?: string;
  /** Overrides the leader contribution owner. */
  leaderSource?: string;
  env?: NodeJS.ProcessEnv;
  telemetryFactory?: TelemetryFactory;
  /** Receives every sanitized record, whether or not a sink is live. */
  metrics?: LogMetricsRecorder;
  /** Called once the sink backend is resolved, so the overlay can report it. */
  onSinkStatus?: (status: SinkStatus | undefined) => void;
  /** Overrides the sink-history transport; injected in tests. */
  metricsSource?: MetricsSource;
  /** Receives telemetry lifecycle failures without writing into the TUI. */
  onDiagnostic?: (message: string) => void;
}

export interface PiTelemetryRuntimeHandle {
  waitForSession(ctx: ExtensionContext): Promise<void>;
  finishSession(reason: string, ctx: ExtensionContext): Promise<void>;
}

function isEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

function contextAttributes(ctx: ExtensionContext): TelemetryAttributes {
  const attributes: TelemetryAttributes = {
    'pi.mode': ctx.mode,
    'pi.session.id': ctx.sessionManager.getSessionId(),
  };
  if (ctx.thinkingLevel) attributes['pi.thinking_level'] = ctx.thinkingLevel;
  if (ctx.model) {
    attributes['gen_ai.provider.name'] = ctx.model.provider;
    attributes['gen_ai.request.model'] = ctx.model.id;
  }
  return attributes;
}

function usageAttributes(message: TurnEndEvent['message']): TelemetryAttributes | undefined {
  if (message.role !== 'assistant') return undefined;
  const attributes: TelemetryAttributes = {
    'gen_ai.response.model': message.responseModel ?? message.model,
    'gen_ai.response.finish_reasons': message.stopReason,
    'gen_ai.usage.input_tokens': message.usage.input,
    'gen_ai.usage.output_tokens': message.usage.output,
    'gen_ai.usage.cache_read_tokens': message.usage.cacheRead,
    'gen_ai.usage.cache_write_tokens': message.usage.cacheWrite,
    'gen_ai.usage.total_tokens': message.usage.totalTokens,
    'gen_ai.usage.cost': message.usage.cost.total,
  };
  if (message.usage.reasoning !== undefined) attributes['gen_ai.usage.reasoning_tokens'] = message.usage.reasoning;
  return attributes;
}

function failureAttributes(message: TurnEndEvent['message']): TelemetryAttributes {
  if (message.role !== 'assistant') return { 'error.type': 'AgentError', outcome: 'error' };
  const aborted = message.stopReason === 'aborted';
  return {
    'error.type': 'ProviderError',
    'error.code': message.stopReason,
    outcome: aborted ? 'aborted' : 'error',
  };
}

function statusFromTelemetry(status: ReturnType<DoomTelemetry['status']>): SinkStatus {
  return {
    service: status.serviceName,
    backend: status.backend,
    endpoint: status.endpoint ?? NO_ENDPOINT,
    endpointSource: status.endpointSource,
    traces: status.traces,
    redaction: true,
    fileFallback: status.fileFallback,
  };
}

export function installPiTelemetryRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  options: PiTelemetryExtensionOptions = {},
  splitReadiness = false,
): PiTelemetryRuntimeHandle {
  const env = options.env ?? process.env;
  const metrics = options.metrics;
  const toolStartedAt = new Map<string, number>();
  let active = true;
  let sessionGeneration = 0;
  let agentStartedAt: number | undefined;
  let telemetry: DoomTelemetry | undefined;
  let telemetrySessionId: string | undefined;
  let sessionReadiness:
    | {
        readonly sessionManager: object;
        readonly coordinator: DoomReadinessCoordinator;
        readonly operation: Promise<void>;
      }
    | undefined;
  let backgroundQueue = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): void => {
    const scheduled = backgroundQueue.then(operation);
    // Telemetry is advisory and the coordinator owns startup failure notification.
    backgroundQueue = scheduled.catch(() => undefined);
  };

  cordis.effect(
    () => async () => {
      active = false;
      sessionGeneration += 1;
      sessionReadiness = undefined;
      toolStartedAt.clear();
      agentStartedAt = undefined;
      const ownedTelemetry = telemetry;
      telemetry = undefined;
      telemetrySessionId = undefined;
      await ownedTelemetry?.shutdown();
    },
    `${PACKAGE_NAME}/telemetry`,
  );

  const emit = async (level: RecordLevel, name: string, attributes: TelemetryAttributes): Promise<void> => {
    if (!active || !telemetry) return;
    if (level === 'debug') await telemetry.recordDebug(name, attributes);
    else if (level === 'warn') await telemetry.recordWarning(name, undefined, attributes);
    else if (level === 'error') await telemetry.recordError(name, undefined, attributes);
    else await telemetry.recordEvent(name, attributes);
  };

  const getTelemetry = (ctx: ExtensionContext): DoomTelemetry => {
    if (!active) throw new Error('Log telemetry runtime is disposed.');
    // The sink groups records by the x-agent-session-id header, which the SDK derives from
    // the environment once per handle. Nothing stamps PI_SESSION_ID for a top-level session
    // (only doompi-workflow does, for spawned children), so without this overlay every record
    // lands in a single unattributed group and per-agent cost cannot be queried.
    const sessionId = ctx.sessionManager.getSessionId();
    // The handle caches those headers, so a second session in the same process would keep
    // reporting under the first session's id. Rebuild when the session changes.
    if (telemetry && telemetrySessionId !== sessionId) {
      const staleTelemetry = telemetry;
      telemetry = undefined;
      telemetrySessionId = undefined;
      enqueue(() => staleTelemetry.shutdown());
    }
    if (!telemetry) {
      telemetrySessionId = sessionId;
      telemetry = createDoomTelemetry({
        serviceName: options.serviceName ?? SERVICE_NAME,
        packageName: PACKAGE_NAME,
        cwd: ctx.cwd,
        env: { ...env, PI_SESSION_ID: sessionId },
        allowFileFallback: options.allowFileFallback,
        telemetryFactory: options.telemetryFactory,
        warn: options.onDiagnostic,
        enableLogs: true,
        enableTraces: env.AGENT_OTEL_TRACES === undefined || isEnabled(env.AGENT_OTEL_TRACES),
        onRecord: (record) => {
          if (active) metrics?.record(record.event, record.attributes);
        },
        onStatus: (status) => {
          if (active) options.onSinkStatus?.(statusFromTelemetry(status));
        },
      });
    }
    if (active) options.onSinkStatus?.(statusFromTelemetry(telemetry.status()));
    return telemetry;
  };

  const waitForSession = async (ctx: ExtensionContext): Promise<void> => {
    const current = sessionReadiness;
    if (!current) return;
    if (current.sessionManager !== ctx.sessionManager) {
      throw new Error('Log readiness belongs to a stale Pi session.');
    }
    await current.operation;
    if (!active || current !== sessionReadiness) {
      throw new Error('Log readiness belongs to a stale extension generation.');
    }
  };

  const enqueueForSession = (ctx: ExtensionContext, operation: () => Promise<void>): void | Promise<void> => {
    const expected = sessionReadiness;
    const run = async (): Promise<void> => {
      if (expected) {
        const ready = await expected.operation.then(
          () => true,
          () => false,
        );
        if (!ready || !active || expected !== sessionReadiness || expected.sessionManager !== ctx.sessionManager) {
          return;
        }
      } else if (!active) {
        return;
      }
      await operation();
    };
    if (!splitReadiness) return run();
    enqueue(run);
    return undefined;
  };

  pi.on('session_start', (event, ctx) => {
    if (!active) return undefined;
    const ownGeneration = ++sessionGeneration;
    toolStartedAt.clear();
    agentStartedAt = undefined;
    const initialize = async (signal?: AbortSignal): Promise<void> => {
      signal?.throwIfAborted();
      getTelemetry(ctx);
      await emit('info', 'pi.session.started', {
        ...contextAttributes(ctx),
        'pi.session.reason': event.reason,
        'pi.session.previous': event.previousSessionFile !== undefined,
      });
      signal?.throwIfAborted();
    };
    const coordinator = splitReadiness ? readDoomReadinessCoordinator(cordis) : undefined;
    if (!coordinator) return initialize();

    const previous = sessionReadiness;
    const operation = (async (): Promise<void> => {
      if (previous?.coordinator === coordinator) await previous.operation.catch(() => undefined);
      if (!active || ownGeneration !== sessionGeneration) return;
      const handle = coordinator.start(
        PACKAGE_NAME,
        `${ctx.sessionManager.getSessionId()}:${ownGeneration}`,
        async (signal) => {
          await initialize(signal);
          return { value: undefined };
        },
      );
      await handle.wait();
    })();
    // Config's coordinator owns the single user-facing failure notification.
    void operation.catch(() => undefined);
    sessionReadiness = { sessionManager: ctx.sessionManager, coordinator, operation };
    return undefined;
  });

  pi.on('before_agent_start', (event, ctx) => {
    if (!active) return;
    return enqueueForSession(ctx, async () => {
      getTelemetry(ctx);
      await emit('info', 'pi.user_prompt', {
        ...contextAttributes(ctx),
        'pi.user_message.length': event.prompt.length,
        'pi.user_message.image_count': event.images?.length ?? 0,
      });
    });
  });

  pi.on('agent_start', (_event, ctx) => {
    if (!active) return;
    return enqueueForSession(ctx, async () => {
      agentStartedAt = Date.now();
      getTelemetry(ctx);
      await emit('info', 'pi.agent.started', contextAttributes(ctx));
    });
  });

  pi.on('turn_start', (event, ctx) => {
    if (!active) return;
    return enqueueForSession(ctx, async () => {
      getTelemetry(ctx);
      await emit('debug', 'pi.turn.started', {
        ...contextAttributes(ctx),
        'pi.turn.index': event.turnIndex,
      });
    });
  });

  pi.on('turn_end', (event, ctx) => {
    if (!active) return;
    return enqueueForSession(ctx, async () => {
      getTelemetry(ctx);
      const usage = usageAttributes(event.message);
      await emit('info', 'pi.turn.finished', {
        ...contextAttributes(ctx),
        'pi.turn.index': event.turnIndex,
        'pi.tool_result.count': event.toolResults.length,
        ...usage,
      });
      if (event.message.role === 'assistant' && FAILURE_STOP_REASONS.has(event.message.stopReason)) {
        await emit(event.message.stopReason === 'aborted' ? 'warn' : 'error', 'pi.turn.failed', {
          ...contextAttributes(ctx),
          'pi.turn.index': event.turnIndex,
          ...failureAttributes(event.message),
          ...usage,
        });
      }
      if (!usage) return;
      for (const result of event.toolResults) {
        await emit('debug', 'pi.tool_token_sample', {
          ...contextAttributes(ctx),
          ...usage,
          'tool.name': result.toolName,
          token_attribution: 'toolCallTurn',
        });
      }
    });
  });

  pi.on('tool_execution_start', (event, ctx) => {
    if (!active) return;
    return enqueueForSession(ctx, async () => {
      toolStartedAt.set(event.toolCallId, Date.now());
      getTelemetry(ctx);
      await emit('debug', 'pi.tool_call', {
        ...contextAttributes(ctx),
        'tool.name': event.toolName,
        'tool.call.id': event.toolCallId,
      });
    });
  });

  pi.on('tool_execution_end', (event, ctx) => {
    if (!active) return;
    return enqueueForSession(ctx, async () => {
      const startedAt = toolStartedAt.get(event.toolCallId);
      toolStartedAt.delete(event.toolCallId);
      getTelemetry(ctx);
      await emit('info', 'pi.tool_result', {
        ...contextAttributes(ctx),
        success: !event.isError,
        'tool.name': event.toolName,
        'tool.call.id': event.toolCallId,
        'tool.result.error': event.isError,
        ...(startedAt === undefined ? {} : { 'tool.duration_ms': Date.now() - startedAt }),
      });
    });
  });

  pi.on('after_provider_response', (event, ctx) => {
    if (!active) return;
    return enqueueForSession(ctx, async () => {
      getTelemetry(ctx);
      const attributes = {
        ...contextAttributes(ctx),
        'http.response.status_code': event.status,
      };
      if (event.status >= API_ERROR_STATUS) await emit('error', 'pi.api_error', attributes);
      else await emit('debug', 'pi.api_response', attributes);
    });
  });

  pi.on('model_select', (event, ctx) => {
    if (!active) return;
    return enqueueForSession(ctx, async () => {
      getTelemetry(ctx);
      await emit('info', 'pi.model.selected', {
        ...contextAttributes(ctx),
        'pi.model.source': event.source,
        'gen_ai.provider.name': event.model.provider,
        'gen_ai.request.model': event.model.id,
      });
    });
  });

  pi.on('agent_end', (event, ctx) => {
    if (!active) return;
    const generation = sessionGeneration;
    return enqueueForSession(ctx, async () => {
      getTelemetry(ctx);
      await emit('info', 'pi.agent.finished', {
        ...contextAttributes(ctx),
        'pi.message.count': event.messages.length,
        ...(agentStartedAt === undefined ? {} : { 'pi.agent.duration_ms': Date.now() - agentStartedAt }),
      });
      if (!active || generation !== sessionGeneration) return;
      agentStartedAt = undefined;
      await telemetry?.flush();
    });
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!active) return;
    return enqueueForSession(ctx, async () => {
      getTelemetry(ctx);
      await emit('debug', 'pi.agent.settled', contextAttributes(ctx));
    });
  });

  return {
    waitForSession,
    async finishSession(reason, ctx) {
      if (!active) return;
      await backgroundQueue;
      const current = sessionReadiness;
      if (current) await current.operation.catch(() => undefined);
      if (!active) return;
      if (current && current !== sessionReadiness) return;
      if (!telemetry) return;
      getTelemetry(ctx);
      await emit('info', 'pi.session.finished', {
        ...contextAttributes(ctx),
        'pi.session.reason': reason,
      });
    },
  };
}

export function registerLogMetricsLeaderBinding(hub: DoomUiHubService, options: { source?: string } = {}): () => void {
  const contribution = hub.registerLeader({
    source: options.source ?? LEADER_SOURCE,
    bindings: [
      {
        id: 'log.metrics',
        path: [
          { key: 'h', label: 'help', detail: HELP_GROUP_DETAIL, order: HELP_GROUP_ORDER },
          { key: 'l', label: 'logs', detail: 'telemetry' },
        ],
        command: { name: LOG_METRICS_COMMAND },
      },
    ],
  });
  return () => contribution.dispose();
}

export async function openLogMetricsOverlay(
  ctx: ExtensionContext,
  getView: () => LogMetricsView,
  query?: MetricsQuery,
): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new LogMetricsOverlayComponent(tui, theme, getView, done, query),
    {
      overlay: true,
      overlayOptions: {
        anchor: 'top-left',
        width: '100%',
        maxHeight: '100%',
        margin: 0,
      },
    },
  );
}

export function installDoomLogRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  options: PiTelemetryExtensionOptions = {},
  splitReadiness = false,
): PiTelemetryRuntimeHandle {
  const env = options.env ?? process.env;
  const metrics = new LogMetricsAggregator();
  // Built lazily so the history transports resolve their sink instance from the
  // same cwd and package identity the telemetry writer registers under; at
  // install time there is no ExtensionContext to read `cwd` from yet.
  let metricsSource = options.metricsSource;
  const resolveMetricsSource = (ctx: ExtensionContext): MetricsSource =>
    (metricsSource ??= createMetricsSource({
      env,
      cwd: ctx.cwd,
      packageName: PACKAGE_NAME,
      serviceName: options.serviceName ?? SERVICE_NAME,
    }));
  let active = true;
  let sink: SinkStatus | undefined;
  let lastDiagnostic: string | undefined;

  cordis.effect(
    () => () => {
      active = false;
      sink = undefined;
      lastDiagnostic = undefined;
    },
    `${PACKAGE_NAME}/runtime`,
  );

  const telemetryRuntime = installPiTelemetryRuntime(
    cordis,
    pi,
    {
      ...options,
      metrics,
      // Always supply a sink so doom-telemetry never falls back to
      // process.emitWarning, which writes raw stderr over the TUI frame.
      // Diagnostics surface in the Log Metrics overlay instead.
      onDiagnostic: (message) => {
        if (!active) return;
        lastDiagnostic = message;
        if (options.onDiagnostic) options.onDiagnostic(message);
        else if (env.AGENT_OTEL_DIAGNOSTICS === DIAGNOSTICS_STDERR) process.emitWarning(message);
      },
      onSinkStatus: (status) => {
        if (!active) return;
        sink = status;
        options.onSinkStatus?.(status);
      },
    },
    splitReadiness,
  );

  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
    return registerLogMetricsLeaderBinding(requireDoomUiHub(uiContext), { source: options.leaderSource });
  });
  pi.registerCommand(LOG_METRICS_COMMAND, {
    description: LOG_METRICS_DESCRIPTION,
    handler: async (_args, ctx) => {
      if (!active) return;
      await telemetryRuntime.waitForSession(ctx);
      if (!active) return;
      const source = resolveMetricsSource(ctx);
      await openLogMetricsOverlay(
        ctx,
        () => ({
          disabled: isEnabled(env.AGENT_TELEMETRY_DISABLED) || isEnabled(env.OTEL_SDK_DISABLED),
          snapshot: metrics.snapshot(),
          sink,
          transport: source.lastTransport(),
          instance: source.instance?.(),
          lastDiagnostic,
        }),
        source.query,
      );
    },
  });
  return telemetryRuntime;
}

interface LogPluginConfig {
  readonly pi: ExtensionAPI;
}

function logPlugin(cordis: Context, { pi }: LogPluginConfig): void {
  const runtime = installDoomLogRuntime(cordis, pi, {}, true);
  let shutdown: Promise<void> | undefined;
  pi.on('session_shutdown', (event, ctx) => {
    shutdown ??= runtime.finishSession(event.reason, ctx);
    return shutdown;
  });
}

/** The package's single standard Pi factory. */
export async function doomLogExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_NAME);
  const fiber = connection.root.plugin(logPlugin, { pi });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }
  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}
