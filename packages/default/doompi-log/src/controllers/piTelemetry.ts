import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext, TurnEndEvent } from '@earendil-works/pi-coding-agent';
import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import {
  type DoomReadinessCoordinator,
  readDoomReadinessCoordinator,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import type { PiEventHandlers } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import type {
  PiTelemetryExtensionOptions,
  PiTelemetryRuntimeHandle,
  TelemetryAttributes,
  RecordLevel,
} from '../types/piTelemetry';
import type { SinkStatus } from '../types/sinkStatus';
import {
  SERVICE_NAME,
  PACKAGE_NAME,
  NO_ENDPOINT,
  API_ERROR_STATUS,
  FAILURE_STOP_REASONS,
} from '../constants/telemetry';
interface PiTelemetryRuntime extends PiTelemetryRuntimeHandle {
  events: PiEventHandlers;
  onDispose(this: void): Promise<void>;
}
import { isEnabled } from '../services/telemetryEnabled';
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

export function createPiTelemetryRuntime(
  cordis: Context,
  options: PiTelemetryExtensionOptions = {},
  splitReadiness = false,
): PiTelemetryRuntime {
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

  return {
    events: {
      session_start: (event, ctx) => {
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
      },

      before_agent_start: (event, ctx) => {
        if (!active) return;
        return enqueueForSession(ctx, async () => {
          getTelemetry(ctx);
          await emit('info', 'pi.user_prompt', {
            ...contextAttributes(ctx),
            'pi.user_message.length': event.prompt.length,
            'pi.user_message.image_count': event.images?.length ?? 0,
          });
        });
      },

      agent_start: (_event, ctx) => {
        if (!active) return;
        return enqueueForSession(ctx, async () => {
          agentStartedAt = Date.now();
          getTelemetry(ctx);
          await emit('info', 'pi.agent.started', contextAttributes(ctx));
        });
      },

      turn_start: (event, ctx) => {
        if (!active) return;
        return enqueueForSession(ctx, async () => {
          getTelemetry(ctx);
          await emit('debug', 'pi.turn.started', {
            ...contextAttributes(ctx),
            'pi.turn.index': event.turnIndex,
          });
        });
      },

      turn_end: (event, ctx) => {
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
          if (event.message.role === 'assistant' && FAILURE_STOP_REASONS.includes(event.message.stopReason)) {
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
      },

      tool_execution_start: (event, ctx) => {
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
      },

      tool_execution_end: (event, ctx) => {
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
      },

      after_provider_response: (event, ctx) => {
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
      },

      model_select: (event, ctx) => {
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
      },

      agent_end: (event, ctx) => {
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
      },

      agent_settled: (_event, ctx) => {
        if (!active) return;
        return enqueueForSession(ctx, async () => {
          getTelemetry(ctx);
          await emit('debug', 'pi.agent.settled', contextAttributes(ctx));
        });
      },
    },
    onDispose: async () => {
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
    waitForSession,
    async finishSession(reason: string, ctx: ExtensionContext) {
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
