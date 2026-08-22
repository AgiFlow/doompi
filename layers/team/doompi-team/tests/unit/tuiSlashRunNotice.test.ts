import { describe, expect, it } from 'vitest';

import type { ExtensionAPI, MessageRenderOptions, Theme } from '@earendil-works/pi-coding-agent';

import { SLASH_RESULT_CUSTOM_TYPE, type SlashRunDetail } from '../../src/adapters/pi/commands/slash/slashCommands';
import { registerSlashRunRenderer, renderSlashRunNotice } from '../../src/adapters/pi/tui/slashRunNotice';

/** Identity theme: every assertion is about WHAT text is emitted, never about colour codes. */
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function detail(overrides: Partial<SlashRunDetail> = {}): SlashRunDetail {
  return {
    agent: 'agiflow-dispatcher',
    runId: 'a1cf85b1-6ac5-4c55-bb49-2eff27469d7f',
    status: 'started',
    ...overrides,
  };
}

describe('renderSlashRunNotice', () => {
  it('renders one run as a single line of agent, status, and run-id prefix', () => {
    const text = renderSlashRunNotice([detail()], theme);

    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain('▶ agiflow-dispatcher · started · a1cf85b1');
    // The full uuid is what the raw markdown carried; the line takes a
    // resolvable prefix instead.
    expect(text).not.toContain('2eff27469d7f');
  });

  it('gives started, completed, held, and failed runs distinct glyphs', () => {
    const glyph = (status: string): string => renderSlashRunNotice([detail({ status })], theme).slice(0, 1);

    expect(glyph('started')).toBe('▶');
    expect(glyph('completed')).toBe('✓');
    // Stopped is held, not failed: it went nowhere wrong, it just stopped.
    expect(glyph('stopped')).toBe('■');
    expect(glyph('failed')).toBe('✗');
  });

  it('indents an error or a warning under its run rather than beside it', () => {
    const failed = renderSlashRunNotice([detail({ status: 'failed', error: 'spawn failed: unknown model' })], theme);
    const warned = renderSlashRunNotice([detail({ warning: 'model fell back to sonnet' })], theme);

    expect(failed.split('\n')).toHaveLength(2);
    expect(failed).toContain('  ⎿  spawn failed: unknown model');
    expect(warned).toContain('  ⎿  model fell back to sonnet');
  });

  it('stays one line per run for a parallel fan-out', () => {
    const details = [detail({ agent: 'a' }), detail({ agent: 'b' }), detail({ agent: 'c' })];

    expect(renderSlashRunNotice(details, theme).split('\n')).toHaveLength(details.length);
  });
});

describe('registerSlashRunRenderer', () => {
  function fakePi(): {
    pi: ExtensionAPI;
    registeredType: () => string | undefined;
    render: (details: unknown, content: string) => unknown;
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
    const render = (details: unknown, content: string): unknown =>
      registered?.({ content, details }, { expanded: false } as MessageRenderOptions, theme);
    return { pi, registeredType: () => registeredType, render };
  }

  it('registers under the same custom type the slash commands send', () => {
    const host = fakePi();

    registerSlashRunRenderer(host.pi);

    expect(host.registeredType()).toBe(SLASH_RESULT_CUSTOM_TYPE);
  });

  it('renders the detail lines when details are present', () => {
    const host = fakePi();
    registerSlashRunRenderer(host.pi);

    const component = host.render([detail({ status: 'completed' })], '## Subagent completed') as {
      render: (width: number) => string[];
    };

    expect(component.render(80).join('\n')).toContain('✓ agiflow-dispatcher · completed');
  });

  it('shows raw content verbatim for a message that carries no details', () => {
    const host = fakePi();
    registerSlashRunRenderer(host.pi);

    const component = host.render(undefined, 'Subagent diagnostics report') as {
      render: (width: number) => string[];
    };

    expect(component.render(80).join('\n')).toContain('Subagent diagnostics report');
  });
});
