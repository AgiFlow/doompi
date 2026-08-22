import type { NodeTelemetryHandle, NodeTelemetryOptions } from '@agimon-ai/log-sink-mcp/telemetry/node';
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogMetricsAggregator } from '../src/services/metrics.ts';
import { LogMetricsOverlayComponent, type LogMetricsView } from '../src/tui/logMetricsOverlay.ts';
import { installLogTestRuntime } from './helpers/extensionRuntime.ts';

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type ComponentFactory = (
  tui: TUI,
  theme: Theme,
  keybindings: unknown,
  done: (result: undefined) => void,
) => LogMetricsOverlayComponent;

/** Identity theme so assertions read as plain text, per doom-pi-ui's rendering suite. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const RENDER_WIDTH = 120;

function createTui(): TUI {
  return { terminal: { rows: 42, columns: RENDER_WIDTH }, requestRender: vi.fn() } as unknown as TUI;
}

function createTelemetryDouble() {
  const noop = () => undefined;
  const telemetry = {
    backend: 'logsink',
    enabled: true,
    endpoint: ':4318',
    endpointSource: 'logsink',
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
  return vi.fn(async (_options: NodeTelemetryOptions) => telemetry);
}

interface Harness {
  handlers: Map<string, Handler[]>;
  commands: Map<string, CommandHandler>;
}

function createHarness(env: NodeJS.ProcessEnv = {}): Harness {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => () => undefined),
    },
    registerCommand: vi.fn((name: string, options: { handler: CommandHandler }) => commands.set(name, options.handler)),
  } as unknown as ExtensionAPI;

  installLogTestRuntime(pi, { env, telemetryFactory: createTelemetryDouble() });
  return { handlers, commands };
}

function createContext(): ExtensionContext {
  return {
    doom: { leader: { register: () => () => undefined } },
    cwd: '/workspace',
    mode: 'json',
    sessionManager: {
      getSessionId: () => 'pi-session',
      getSessionFile: () => '/workspace/session.jsonl',
    },
  } as unknown as ExtensionContext;
}

/** Runs `/log-metrics` and renders whatever the command handed the overlay. */
async function openOverlay(harness: Harness): Promise<{ output: string; options: Record<string, unknown> }> {
  const handler = harness.commands.get('log-metrics');
  if (!handler) throw new Error('log-metrics command was not registered');

  let factory: ComponentFactory | undefined;
  let options: Record<string, unknown> = {};
  const ctx = {
    ...createContext(),
    ui: {
      custom: vi.fn(async (build: ComponentFactory, customOptions: Record<string, unknown>) => {
        factory = build;
        options = customOptions;
        return undefined;
      }),
    },
  } as unknown as ExtensionContext;

  await handler('', ctx);
  if (!factory) throw new Error('overlay factory was never built');

  const component = factory(createTui(), theme, undefined, vi.fn());
  const output = component.render(RENDER_WIDTH).join('\n');
  component.dispose();

  return { output, options };
}

describe('doom-log Pi extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers telemetry handlers, the leader binding, and the metrics command', () => {
    const harness = createHarness();

    expect(harness.handlers.has('tool_execution_end')).toBe(true);
    expect(harness.commands.has('log-metrics')).toBe(true);
    expect(harness.handlers.has('session_start')).toBe(true);
  });

  it('opens the overlay with full-screen geometry', async () => {
    const harness = createHarness();

    const { options } = await openOverlay(harness);

    expect(options).toEqual({
      overlay: true,
      overlayOptions: {
        anchor: 'top-left',
        width: '100%',
        maxHeight: '100%',
        margin: 0,
      },
    });
  });

  it('shows the session aggregate and the resolved sink in the overlay', async () => {
    const harness = createHarness();
    for (const session of harness.handlers.get('session_start') ?? []) {
      await session({ type: 'session_start', reason: 'startup' }, createContext());
    }

    const { output } = await openOverlay(harness);

    // The record the session emitted is what the aggregator counted: the
    // findings panel only reaches a verdict once records exist.
    expect(output).toContain('no failures, no outliers');
    expect(output).not.toContain('no records yet');
    expect(output).toContain('SINK STATUS');
    expect(output).toContain('logsink');
    expect(output).toContain(':4318');
  });

  it('renders the disabled state when AGENT_TELEMETRY_DISABLED is set', async () => {
    const harness = createHarness({ AGENT_TELEMETRY_DISABLED: '1' });

    const { output } = await openOverlay(harness);

    expect(output).toContain('AGENT_TELEMETRY_DISABLED');
    expect(output).not.toContain('TOOL LATENCY');
  });
});

describe('LogMetricsOverlayComponent edge states', () => {
  const emptyView = (): LogMetricsView => ({
    disabled: false,
    snapshot: new LogMetricsAggregator().snapshot(),
    sink: undefined,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an empty session without inventing values', () => {
    const component = new LogMetricsOverlayComponent(createTui(), theme, emptyView, vi.fn());

    const output = component.render(RENDER_WIDTH).join('\n');
    component.dispose();

    expect(output).toContain('TOOL COST');
    // No tool has run, so there is nothing to cost.
    expect(output).toContain('no tool calls yet');
  });

  it('uses the shared compact takeover below its minimum framed width', () => {
    const component = new LogMetricsOverlayComponent(createTui(), theme, emptyView, vi.fn());

    const output = component.render(3);
    component.dispose();

    expect(output).toHaveLength(42);
    expect(output[0]).not.toContain('TOOL COST');
  });

  it('renders enabled traces, allowed file fallback, and a call with no latency sample', () => {
    const aggregator = new LogMetricsAggregator();
    // No `tool.duration_ms`: the call counts but contributes no p95 bar.
    aggregator.record('pi.tool_result', { 'tool.name': 'grep', 'tool.call.id': 'g', 'tool.result.error': false });
    const view = (): LogMetricsView => ({
      disabled: false,
      snapshot: aggregator.snapshot(),
      sink: {
        service: 'pi',
        backend: 'otlp/http',
        endpoint: ':4318',
        endpointSource: 'env',
        traces: true,
        redaction: false,
        fileFallback: true,
      },
    });
    const component = new LogMetricsOverlayComponent(createTui(), theme, view, vi.fn());

    // Sink wiring lives behind `?`; the default view spends its rows on numbers.
    const summary = component.render(RENDER_WIDTH).join('\n');
    component.handleInput('?');
    const detail = component.render(RENDER_WIDTH).join('\n');
    component.dispose();

    expect(detail).toContain('on · AGENT_OTEL_TRACES');
    expect(detail).toContain('off · metadata only');
    expect(detail).toContain('allowed');
    expect(summary).toContain('grep');
  });

  it('re-renders on refresh and on invalidate without closing', () => {
    const tui = createTui();
    const done = vi.fn();
    const component = new LogMetricsOverlayComponent(tui, theme, emptyView, done);

    component.handleInput('r');
    component.invalidate();
    component.dispose();

    expect(tui.requestRender).toHaveBeenCalledTimes(2);
    expect(done).not.toHaveBeenCalled();
  });
});

describe('LogMetricsOverlayComponent sink history panels', () => {
  const report = {
    generatedAt: new Date('2026-08-02T07:00:00Z'),
    groupBy: 'session',
    sort: 'total-tokens',
    toolSort: 'p90-total-tokens',
    period: 'day',
    bucket: 'hour',
    timeline: [
      {
        bucketStart: '2026-08-01T18:00:00.000Z',
        label: '2026-08-02 04:00',
        totalTokens: 15228526,
        totalRecords: 900,
        issueCount: 2,
        inputTokens: 9,
        outputTokens: 9,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        usageEventCount: 9,
      },
      {
        bucketStart: '2026-08-01T19:00:00.000Z',
        label: '2026-08-02 05:00',
        totalTokens: 18102413,
        totalRecords: 950,
        issueCount: 0,
        inputTokens: 9,
        outputTokens: 9,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        usageEventCount: 9,
      },
    ],
    filters: {},
    totals: {
      groupCount: 903,
      totalRecords: 139489,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 78306262,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      usageEventCount: 5,
      logRecords: 1,
      spanRecords: 0,
      returnedGroups: 2,
      failedGroups: 0,
      issueCount: 3,
      tokenCoveragePercent: 100,
      models: {},
      providers: {},
    },
    groups: [
      {
        key: 'd4942aae-71a1',
        sessionId: 'd4942aae-71a1',
        agentName: 'claude-code',
        totalTokens: 3810955,
        inputTokens: 76734,
        outputTokens: 2909450,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        usageEventCount: 3517,
        workflowRunKey: null,
        workflowRunId: null,
        workflowName: null,
        jobName: null,
        stepName: null,
        model: null,
        provider: null,
        firstSeen: null,
        lastSeen: null,
        totalRecords: 27755,
        logRecords: 27755,
        spanRecords: 0,
        issueCount: 0,
        failed: false,
        byCategory: {},
        models: {},
        providers: {},
        tokenCoveragePercent: 100,
      },
      {
        key: 'elicit-f4759a5b',
        sessionId: 'elicit-f4759a5b',
        agentName: 'doom-pi',
        totalTokens: 540422,
        inputTokens: 116108,
        outputTokens: 890,
        cachedInputTokens: 423424,
        reasoningOutputTokens: 0,
        usageEventCount: 5,
        workflowRunKey: null,
        workflowRunId: null,
        workflowName: null,
        jobName: null,
        stepName: null,
        model: null,
        provider: null,
        firstSeen: null,
        lastSeen: null,
        totalRecords: 34,
        logRecords: 34,
        spanRecords: 0,
        issueCount: 0,
        failed: false,
        byCategory: {},
        models: {},
        providers: {},
        tokenCoveragePercent: 100,
      },
    ],
    tools: { returnedTools: 0, rows: [] },
  } as never;

  const view = (): LogMetricsView => ({
    disabled: false,
    snapshot: new LogMetricsAggregator().snapshot(),
    sink: undefined,
    transport: 'http',
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('renders ranked token consumers and the burn timeline from the sink', async () => {
    const query = vi.fn().mockResolvedValue(report);
    const component = new LogMetricsOverlayComponent(createTui(), theme, view, vi.fn(), query);
    await flush();
    const output = component.render(RENDER_WIDTH).join('\n');

    expect(query).toHaveBeenCalledWith({ groupBy: 'session', period: 'day', limit: 6 });
    expect(output).toContain('TOP CONSUMERS · by session · day');
    expect(output).toContain('TOKEN BURN · per hour');
    expect(output).toContain('d4942aae-71a1');
    expect(output).toContain('claude-code');
    // 3.8M tokens render compacted, not as a raw count.
    expect(output).toContain('3.8M');
    expect(output).toContain('2026-08-02 05:00');
    component.dispose();
  });

  it('cycles dimension and period, re-querying each time', async () => {
    const query = vi.fn().mockResolvedValue(report);
    const component = new LogMetricsOverlayComponent(createTui(), theme, view, vi.fn(), query);
    await flush();

    component.handleInput('g');
    expect(query).toHaveBeenLastCalledWith({ groupBy: 'agent', period: 'day', limit: 6 });
    component.handleInput('p');
    expect(query).toHaveBeenLastCalledWith({ groupBy: 'agent', period: 'week', limit: 6 });
    await flush();
    expect(component.render(RENDER_WIDTH).join('\n')).toContain('TOP CONSUMERS · by agent · week');

    component.dispose();
  });

  it('names the scope it read instead of reporting a bare zero', async () => {
    // A repository-scoped database that no sink ever filled answers "0 groups",
    // which reads as "this never happened" rather than "you asked the wrong one".
    const empty = { ...(report as object), groups: [], timeline: [], totals: { groupCount: 0 } } as never;
    const scopedView = (): LogMetricsView => ({
      ...view(),
      instance: { scope: 'local', dbPath: '/tmp/log-sink-mcp/example-repo/session.db' },
    });
    const component = new LogMetricsOverlayComponent(
      createTui(),
      theme,
      scopedView,
      vi.fn(),
      vi.fn().mockResolvedValue(empty),
    );
    await flush();
    const output = component.render(RENDER_WIDTH).join('\n');

    // The transport carries the other half of the diagnosis: `http` means a
    // daemon answered and the period is genuinely empty, `cli` means none was
    // reachable and the database was read directly.
    expect(output).toContain('http · no records · local db');
    expect(output).not.toContain('0 groups');
    component.dispose();
  });

  it('omits the scope when the instance could not be resolved', async () => {
    const empty = { ...(report as object), groups: [], timeline: [], totals: { groupCount: 0 } } as never;
    const component = new LogMetricsOverlayComponent(
      createTui(),
      theme,
      view,
      vi.fn(),
      vi.fn().mockResolvedValue(empty),
    );
    await flush();
    const output = component.render(RENDER_WIDTH).join('\n');

    expect(output).toContain('http · no records');
    expect(output).not.toContain('undefined');
    component.dispose();
  });

  it('surfaces a query failure instead of an empty panel', async () => {
    const query = vi.fn().mockRejectedValue(new Error('sink is an older version'));
    const component = new LogMetricsOverlayComponent(createTui(), theme, view, vi.fn(), query);
    await flush();

    expect(component.render(RENDER_WIDTH).join('\n')).toContain('sink is an older version');
    component.dispose();
  });

  it('reports no history when no transport is wired', () => {
    const component = new LogMetricsOverlayComponent(createTui(), theme, view, vi.fn());

    expect(component.render(RENDER_WIDTH).join('\n')).toContain('no sink history available');
    component.dispose();
  });
});
