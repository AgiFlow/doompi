import type { Theme } from '@earendil-works/pi-coding-agent';
import { type TUI, visibleWidth } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogMetricsAggregator } from '../src/services/metrics.ts';
import { LogMetricsOverlayComponent, type LogMetricsView } from '../src/tui/logMetricsOverlay.ts';

/** Identity theme so assertions read as plain text, per doom-pi-ui's rendering suite. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const OVERLAY_MIN_WIDTH = 60;
const TERMINAL_ROWS = 42;

function createTui(rows = TERMINAL_ROWS, columns = 120): TUI {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as unknown as TUI;
}

function populatedSnapshot() {
  const aggregator = new LogMetricsAggregator({ now: () => 1_000 });
  for (let ms = 1; ms <= 40; ms++) {
    aggregator.record('pi.tool_call', { 'tool.name': 'bash' });
    aggregator.record('pi.tool_result', {
      'tool.name': 'bash',
      'tool.call.id': `bash-${ms}`,
      'tool.result.error': false,
      'tool.duration_ms': ms * 100,
    });
  }
  aggregator.record('pi.tool_result', {
    'tool.name': 'edit',
    'tool.call.id': 'edit-1',
    'tool.result.error': true,
    'tool.duration_ms': 120,
  });
  aggregator.record('pi.api_error', { 'http.response.status_code': 529 });
  aggregator.record('pi.turn.finished', {
    'gen_ai.usage.input_tokens': 3_600_000,
    'gen_ai.usage.output_tokens': 512_000,
    'gen_ai.usage.total_tokens': 4_112_000,
    'gen_ai.usage.cache_read_tokens': 240_000,
    'gen_ai.usage.cache_write_tokens': 1_100_000,
    'gen_ai.usage.cost': 74.91,
  });
  // One sample per tool result in the turn, carrying that turn's total: the
  // shape the extension actually emits.
  for (const [tool, total] of [
    ['subagent', 900_000],
    ['bash', 120_000],
    ['bash', 140_000],
  ] as const) {
    aggregator.record('pi.tool_token_sample', {
      'tool.name': tool,
      'gen_ai.usage.total_tokens': total,
      token_attribution: 'toolCallTurn',
    });
  }
  aggregator.record('pi.turn.failed', { outcome: 'aborted', 'error.type': 'ProviderError' });
  aggregator.record('pi.user_prompt', { 'pi.user_message.length': 42 });
  return aggregator.snapshot();
}

function populatedView(overrides: Partial<LogMetricsView> = {}): LogMetricsView {
  return {
    disabled: false,
    snapshot: populatedSnapshot(),
    sink: {
      service: 'pi',
      backend: 'otlp/http',
      endpoint: ':4318',
      endpointSource: 'discovered',
      traces: false,
      redaction: true,
      fileFallback: false,
    },
    ...overrides,
  };
}

function renderView(view: LogMetricsView, width = 120, rows = TERMINAL_ROWS): string[] {
  const component = new LogMetricsOverlayComponent(createTui(rows, width), theme, () => view, vi.fn());
  try {
    return component.render(width);
  } finally {
    component.dispose();
  }
}

function expectWidth(lines: string[], width: number): void {
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

describe('LogMetricsOverlayComponent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every decision panel at width 120', () => {
    const output = renderView(populatedView()).join('\n');

    expect(output).toContain('LOG METRICS');
    for (const label of ['TOKENS', 'CACHE', 'COST', 'TURNS', 'TOOL FAIL', 'ISSUES']) {
      expect(output).toContain(label);
    }
    expect(output).toContain('WHAT TO FIX');
    expect(output).toContain('TOOL COST');
    expect(output).toContain('TOP CONSUMERS');
    expect(output).toContain('RECENT ERRORS');
    expect(output).toContain('SINK STATUS');
  });

  it('spends no rows on counters nothing follows from', () => {
    const output = renderView(populatedView()).join('\n');

    // Per-record volume and raw event counts moved out: they tracked the
    // workload and left the user with nothing to change.
    expect(output).not.toContain('EVENT VOLUME');
    expect(output).not.toContain('TOOL LATENCY');
    // The collection caveats live behind `?` rather than in the default view.
    expect(output).not.toContain('COLLECTION');
  });

  it('renders the leader breadcrumb and session scope subtitle', () => {
    const output = renderView(populatedView()).join('\n');

    expect(output).toContain('h / help');
    expect(output).toContain('l / logs');
    expect(output).toContain('doom-log');
    expect(output).toContain('this session');
  });

  it('keeps every line within the terminal width', () => {
    for (const width of [120, 80, OVERLAY_MIN_WIDTH]) {
      expectWidth(renderView(populatedView(), width), width);
    }
  });

  it('fills the terminal height', () => {
    expect(renderView(populatedView())).toHaveLength(TERMINAL_ROWS);
  });

  it('renders a populated session with a tool error', () => {
    const view = populatedView();
    const output = renderView(view).join('\n');

    expect(view.snapshot.failedToolCalls).toBeGreaterThan(0);
    expect(view.snapshot.recentErrors.length).toBeGreaterThan(0);
    // Per-tool cost rows come straight from the aggregator breakdown.
    expect(output).toContain('bash');
    expect(output).toContain('edit');
    expect(output).toContain('tool_result');
    expect(output).toContain('529');
  });

  it('renders an explicit disabled state instead of zeroed stats', () => {
    const output = renderView({
      disabled: true,
      snapshot: new LogMetricsAggregator().snapshot(),
      sink: undefined,
    }).join('\n');

    expect(output.toLowerCase()).toContain('disabled');
    expect(output).toContain('AGENT_TELEMETRY_DISABLED');
    // The whole point of the disabled state: it must not read as a real
    // session that happened to do nothing.
    expect(output).not.toMatch(/TOKENS\s+0\b/);
    expect(output).not.toContain('WHAT TO FIX');
  });

  it('still renders in-process metrics when no sink handle is live', () => {
    // The file-fallback path shuts the sink down, but aggregation never
    // depended on it, so the stats and latency panels must survive.
    const output = renderView(populatedView({ sink: undefined })).join('\n');

    expect(output).toContain('TOOL COST');
    expect(output).toContain('bash');
    expect(output).toContain('SINK STATUS');
    expect(output.toLowerCase()).toContain('not connected');
  });

  it('renders only sink fields the telemetry handle can supply', () => {
    const output = renderView(populatedView()).join('\n').toLowerCase();

    expect(output).toContain('backend');
    expect(output).toContain('endpoint');
    // NodeTelemetryHandle exposes no queue counters, so the overlay must not
    // invent them.
    expect(output).not.toContain('buffered');
    expect(output).not.toContain('dropped');
  });

  it('flags a disabled backend without asserting a cause the status cannot carry', () => {
    // `disabled` is also the status a handle carries before it initializes, so
    // the row states the effect and routes the cause to the detail pane.
    const view = populatedView({
      sink: {
        service: 'pi',
        backend: 'disabled',
        endpoint: 'none',
        endpointSource: 'none',
        traces: false,
        redaction: true,
        fileFallback: false,
      },
    });

    const output = renderView(view).join('\n');

    expect(output).toContain('? for details');
    // Naming one remedy here would diagnose a state the flag does not identify.
    expect(output).not.toContain('LOG_SINK_ENDPOINT');
  });

  it('leaves the export row off a live sink', () => {
    expect(renderView(populatedView()).join('\n')).not.toContain('? for details');
  });

  it('reports which sink database the history panels read behind the detail key', () => {
    const view = populatedView({
      instance: {
        scope: 'local',
        dbPath: '/tmp/log-sink-mcp/example-repo/session.db',
        registeredName: '@agimon-ai/doompi-log',
      },
    });
    const component = new LogMetricsOverlayComponent(createTui(), theme, () => view, vi.fn());
    try {
      component.handleInput('?');
      const detail = component.render(120).join('\n');

      expect(detail).toContain('HISTORY');
      expect(detail).toContain('local');
      // The path is what makes an empty panel diagnosable rather than mysterious.
      expect(detail).toContain('/tmp/log-sink-mcp/example-repo/session.db');
    } finally {
      component.dispose();
    }
  });

  it('renders only supported footer key hints', () => {
    const output = renderView(populatedView()).join('\n');

    expect(output).toContain('refresh');
    // Keys render in filled caps, so the label sits a pad column away: ` esc  close`.
    expect(output).toContain('esc  close');
    for (const unsupportedHint of ['↑↓', 'e errors', 't traces', 'y copy']) {
      expect(output).not.toContain(unsupportedHint);
    }
  });

  it('states an action beside each finding rather than a bare number', () => {
    const output = renderView(populatedView()).join('\n');

    // A turn was aborted, so the panel must say the work was paid for twice.
    expect(output).toContain('aborted');
    expect(output).toContain('paid for, then thrown away');
    // Cache hit is ~6% on the fixture, well under the healthy threshold.
    expect(output).toContain('pin stable context first');
  });

  it('ranks tools by cost per call, not by how often they run', () => {
    const output = renderView(populatedView());
    const rows = output.filter((line) => line.includes('subagent') || /\bbash\s+█/.test(line));

    // bash ran 40 times to subagent's one, but subagent drags a 900k turn.
    expect(rows[0]).toContain('subagent');
  });

  it('reports no findings for a session that has produced nothing', () => {
    const output = renderView({
      disabled: false,
      snapshot: new LogMetricsAggregator().snapshot(),
      sink: undefined,
    }).join('\n');

    expect(output).toContain('WHAT TO FIX');
    expect(output).toContain('no records yet');
    // An empty session must not be congratulated for being healthy.
    expect(output).not.toContain('nothing to act on');
  });

  it('moves sink wiring and collection caveats behind the detail key', () => {
    const component = new LogMetricsOverlayComponent(createTui(), theme, () => populatedView(), vi.fn());
    try {
      expect(component.render(120).join('\n')).not.toContain('redaction');

      component.handleInput('?');
      const detail = component.render(120).join('\n');

      expect(detail).toContain('COLLECTION');
      expect(detail).toContain('redaction');
      expect(detail).toContain('TOOL COST ATTRIBUTION');
      // The caveat that keeps the column honest must travel with it.
      expect(detail).toContain('not a per-tool share of spend');

      component.handleInput('?');
      expect(component.render(120).join('\n')).toContain('WHAT TO FIX');
    } finally {
      component.dispose();
    }
  });

  it('keeps the detail pane within the terminal width', () => {
    for (const width of [120, 80, OVERLAY_MIN_WIDTH]) {
      const component = new LogMetricsOverlayComponent(createTui(TERMINAL_ROWS, width), theme, populatedView, vi.fn());
      try {
        component.handleInput('?');
        expectWidth(component.render(width), width);
      } finally {
        component.dispose();
      }
    }
  });

  it('closes on escape', () => {
    const done = vi.fn();
    const component = new LogMetricsOverlayComponent(createTui(), theme, () => populatedView(), done);

    component.handleInput('\x1b');

    expect(done).toHaveBeenCalledOnce();
    component.dispose();
  });
});
