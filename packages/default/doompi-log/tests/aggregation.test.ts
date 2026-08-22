import type { NodeTelemetryHandle, NodeTelemetryOptions } from '@agimon-ai/log-sink-mcp/telemetry/node';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogMetricsAggregator } from '../src/services/metrics.ts';
import { installTelemetryTestRuntime } from './helpers/extensionRuntime.ts';

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => Promise<void>;

function createContext(): ExtensionContext {
  return {
    cwd: '/workspace',
    mode: 'json',
    sessionManager: {
      getSessionId: () => 'pi-session',
      getSessionFile: () => '/workspace/session.jsonl',
    },
  } as unknown as ExtensionContext;
}

function createTelemetryDouble(backend: NodeTelemetryHandle['backend'] = 'logsink') {
  const noop = () => undefined;
  const telemetry = {
    backend,
    enabled: true,
    logger: {
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      getTraceContext: () => ({}),
      flush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    },
    flush: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  } as unknown as NodeTelemetryHandle;
  return { telemetry, telemetryFactory: vi.fn(async (_options: NodeTelemetryOptions) => telemetry) };
}

interface Harness {
  handlers: Map<string, Handler>;
  metrics: LogMetricsAggregator;
}

function createHarness(options: { env?: NodeJS.ProcessEnv; backend?: NodeTelemetryHandle['backend'] } = {}): Harness {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
    registerCommand: vi.fn(),
  } as unknown as ExtensionAPI;
  const metrics = new LogMetricsAggregator();
  const { telemetryFactory } = createTelemetryDouble(options.backend);
  installTelemetryTestRuntime(pi, { env: options.env ?? {}, telemetryFactory, metrics });
  return { handlers, metrics };
}

async function emit(harness: Harness, name: string, event: Record<string, unknown>): Promise<void> {
  const handler = harness.handlers.get(name);
  if (!handler) throw new Error(`Missing handler: ${name}`);
  await handler({ type: name, ...event }, createContext());
}

describe('metrics aggregation wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [200, 0],
    [399, 0],
    [400, 1],
    [500, 1],
  ])('counts an api error for status %i as %i error(s)', async (status, expected) => {
    const harness = createHarness();

    await emit(harness, 'after_provider_response', { status, headers: {} });

    expect(harness.metrics.snapshot().errors).toBe(expected);
  });

  it('records a tool duration from the start/end pair', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();

      await emit(harness, 'tool_execution_start', { toolCallId: 'call-1', toolName: 'bash', args: {} });
      vi.advanceTimersByTime(250);
      await emit(harness, 'tool_execution_end', {
        toolCallId: 'call-1',
        toolName: 'bash',
        result: {},
        isError: false,
      });
      const bash = harness.metrics.snapshot().toolLatency.find((entry) => entry.name === 'bash');

      expect(bash?.calls).toBe(1);
      expect(bash?.p95Ms).toBeGreaterThanOrEqual(250);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aggregates turn usage into token and cost totals', async () => {
    const harness = createHarness();

    await emit(harness, 'turn_end', {
      turnIndex: 1,
      toolResults: [],
      message: {
        role: 'assistant',
        provider: 'openai-codex',
        model: 'gpt-5.6',
        stopReason: 'stop',
        usage: {
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 1,
          totalTokens: 126,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2.5 },
        },
      },
    });
    const snapshot = harness.metrics.snapshot();

    expect(snapshot.tokens.total).toBe(126);
    expect(snapshot.cost).toBeCloseTo(2.5, 5);
  });

  it('keeps aggregating when telemetry is disabled outright', async () => {
    // AGENT_TELEMETRY_DISABLED short-circuits the sink, but in-process metrics
    // never needed it, so the overlay still has something to show.
    const harness = createHarness({ env: { AGENT_TELEMETRY_DISABLED: '1' } });

    await emit(harness, 'after_provider_response', { status: 503, headers: {} });

    expect(harness.metrics.snapshot().errors).toBe(1);
  });

  it('keeps aggregating when the sink shut down for file fallback', async () => {
    // The file backend is torn down unless fallback is opted in; aggregation
    // must not be collateral damage.
    const harness = createHarness({ backend: 'file' });

    await emit(harness, 'tool_execution_end', {
      toolCallId: 'call-2',
      toolName: 'read',
      result: {},
      isError: true,
    });
    const snapshot = harness.metrics.snapshot();

    expect(snapshot.toolCalls).toBe(1);
    expect(snapshot.failedToolCalls).toBe(1);
  });
});
