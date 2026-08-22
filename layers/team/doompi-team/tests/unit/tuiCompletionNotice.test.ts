import { describe, expect, it } from 'vitest';

import type { ExtensionAPI, MessageRenderOptions, Theme } from '@earendil-works/pi-coding-agent';

import type { CompletionNotifyDetails } from '../../src/adapters/runs/background/notify';
import { SUBAGENT_NOTIFY_MESSAGE_TYPE } from '../../src/adapters/runs/background/notify';
import { registerCompletionRenderer, renderCompletionNotice } from '../../src/adapters/pi/tui/completionNotice';

/**
 * Identity theme: every assertion here is about WHAT text is emitted and
 * whether it is gated, never about colour codes. Same shape as
 * `tuiFleetTranscript.test.ts`'s theme stub.
 */
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function detail(overrides: Partial<CompletionNotifyDetails> = {}): CompletionNotifyDetails {
  return {
    agent: 'porter',
    runId: 'run-porter',
    status: 'completed',
    resultPreview: 'ported the module',
    ...overrides,
  };
}

describe('renderCompletionNotice', () => {
  it('renders a single completion as agent, status, and preview', () => {
    const text = renderCompletionNotice([detail()], { expanded: false }, theme);

    expect(text).toContain('porter');
    expect(text).toContain('completed');
    expect(text).toContain('ported the module');
  });

  it('shows only the first preview line when collapsed', () => {
    const text = renderCompletionNotice(
      [detail({ resultPreview: 'first line\nsecond line\nthird line' })],
      { expanded: false },
      theme,
    );

    expect(text).toContain('first line');
    expect(text).not.toContain('second line');
  });

  it('shows every preview line when expanded', () => {
    const text = renderCompletionNotice(
      [detail({ resultPreview: 'first line\nsecond line' })],
      { expanded: true },
      theme,
    );

    expect(text).toContain('first line');
    expect(text).toContain('second line');
  });

  it('falls back to "(no output)" for an empty preview rather than an empty block', () => {
    expect(renderCompletionNotice([detail({ resultPreview: '   ' })], { expanded: false }, theme)).toContain(
      '(no output)',
    );
  });

  it('distinguishes paused from failed, because a paused run can still be resumed', () => {
    const paused = renderCompletionNotice([detail({ status: 'paused' })], { expanded: false }, theme);
    const failed = renderCompletionNotice([detail({ status: 'failed' })], { expanded: false }, theme);

    expect(paused).toContain('paused');
    expect(failed).toContain('failed');
    expect(paused).not.toBe(failed);
  });

  it('renders duration and task position when present', () => {
    const text = renderCompletionNotice(
      [detail({ durationMs: 65_000, taskInfo: ' (2/3)' })],
      { expanded: false },
      theme,
    );

    expect(text).toContain('(2/3)');
    expect(text).toMatch(/1m/);
  });

  it('surfaces the handoff path and session line when present', () => {
    const text = renderCompletionNotice(
      [detail({ handoffPath: '/tmp/handoff.md', sessionLabel: 'session', sessionValue: '/tmp/s.jsonl' })],
      { expanded: false },
      theme,
    );

    expect(text).toContain('/tmp/handoff.md');
    expect(text).toContain('/tmp/s.jsonl');
  });

  /**
   * A fan-out of N children emits ONE grouped notice. Collapsed, it must stay
   * proportional to the child count rather than to their combined output.
   */
  it('renders a grouped notice with a count header and one line per run when collapsed', () => {
    const details = [
      detail({ agent: 'a', resultPreview: 'a1\na2\na3' }),
      detail({ agent: 'b', resultPreview: 'b1\nb2\nb3' }),
      detail({ agent: 'c', resultPreview: 'c1\nc2\nc3' }),
    ];

    const text = renderCompletionNotice(details, { expanded: false }, theme);

    expect(text).toContain('Background tasks completed (3)');
    expect(text).toContain('a1');
    expect(text).not.toContain('a2');
    expect(text.split('\n')).toHaveLength(1 + details.length * 2); // header + (agent line + one preview line) each
  });
});

describe('registerCompletionRenderer', () => {
  function fakePi(): {
    pi: ExtensionAPI;
    render: (details: unknown, content: string, options?: MessageRenderOptions) => unknown;
  } {
    let registered: ((message: unknown, options: MessageRenderOptions, theme: Theme) => unknown) | undefined;
    let registeredType: string | undefined;
    const pi = {
      registerMessageRenderer: (
        customType: string,
        renderer: (message: unknown, options: MessageRenderOptions, theme: Theme) => unknown,
      ) => {
        registeredType = customType;
        registered = renderer;
      },
    } as unknown as ExtensionAPI;
    const render = (details: unknown, content: string, options?: MessageRenderOptions): unknown => {
      expect(registeredType).toBe(SUBAGENT_NOTIFY_MESSAGE_TYPE);
      return registered?.({ content, details }, options ?? ({ expanded: false } as MessageRenderOptions), theme);
    };
    return { pi, render };
  }

  it('registers under the same custom type the notifier sends', () => {
    const { pi, render } = fakePi();
    registerCompletionRenderer(pi);

    // The type assertion lives inside `render`; reaching it at all proves the
    // registration happened under the shared token.
    expect(render([detail()], 'ignored')).toBeDefined();
  });

  it('renders from structured details, not from the formatted content', () => {
    const { pi, render } = fakePi();
    registerCompletionRenderer(pi);

    // Content and details deliberately disagree: if the renderer ever went
    // back to parsing content, this would surface the wrong agent name.
    const component = render([detail({ agent: 'from-details' })], 'Background task completed: **from-content**');

    expect(JSON.stringify(component)).toContain('from-details');
    expect(JSON.stringify(component)).not.toContain('from-content');
  });

  it('falls back to raw content when a message carries no details', () => {
    const { pi, render } = fakePi();
    registerCompletionRenderer(pi);

    const component = render(undefined, 'Background task completed: **legacy**');

    expect(JSON.stringify(component)).toContain('legacy');
  });

  it('ignores a details field that is not an array of completion details', () => {
    const { pi, render } = fakePi();
    registerCompletionRenderer(pi);

    const component = render([{ notAgent: true }], 'raw content wins');

    expect(JSON.stringify(component)).toContain('raw content wins');
  });
});
