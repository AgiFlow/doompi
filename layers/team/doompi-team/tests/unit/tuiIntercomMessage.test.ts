import type { MessageRenderOptions, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import {
  createIntercomMessageRenderer,
  renderIntercomMessage,
} from '../../src/extensions/workspaces/sessions/(frontend)/message/_lib/intercom-message.cli';
import { TEAM_MESSAGE_CUSTOM_TYPE, type IntercomMessageDetails } from '../../src/services/nativeTeamChannel';

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const details: IntercomMessageDetails = {
  kind: 'send',
  from: { name: 'alan-developer-1', role: 'subagent', agent: 'doompi-developer' },
  message: 'Implemented the bridge.\nTests pass.',
  requestId: 'message-1',
};

function rendered(component: Component): string {
  return component.render(120).join('\n');
}

describe('the intercom message renderer', () => {
  it('uses the shared Doom tool chrome for the sender and message body', () => {
    const text = rendered(renderIntercomMessage(details, theme));

    expect(text).toContain('INTERCOM');
    expect(text).toContain('from alan-developer-1');
    expect(text).toContain('doompi-developer');
    expect(text).toContain('Implemented the bridge.');
    expect(text).toContain('Tests pass.');
    expect(text).toContain('─');
  });

  it('labels asks and inline senders distinctly', () => {
    const text = rendered(
      renderIntercomMessage({ ...details, kind: 'ask', from: { ...details.from, inline: true } }, theme),
    );

    expect(text).toContain('question');
    expect(text).toContain('inline');
  });

  it('registers for native intercom messages and keeps legacy content readable', () => {
    const [customType, renderer] = createIntercomMessageRenderer();
    const options = { expanded: false, outputPad: 1 } as MessageRenderOptions;

    expect(customType).toBe(TEAM_MESSAGE_CUSTOM_TYPE);
    const legacy = renderer(
      { role: 'custom', customType, content: 'legacy intercom message', display: true, timestamp: Date.now() },
      options,
      theme,
    );
    expect(legacy).toBeDefined();
    if (legacy) expect(rendered(legacy)).toContain('legacy intercom message');
  });

  it('falls back to raw content for malformed structured details', () => {
    const [, renderer] = createIntercomMessageRenderer();
    const options = { expanded: false, outputPad: 1 } as MessageRenderOptions;
    const malformed = [
      { kind: 'unknown', from: details.from, message: 'x', requestId: 'x' },
      { kind: 'send', message: 'x', requestId: 'x' },
      { kind: 'send', from: details.from, message: 1, requestId: 'x' },
      { kind: 'send', from: details.from, message: 'x', requestId: 1 },
    ];

    for (const value of malformed) {
      const component = renderer(
        {
          role: 'custom',
          customType: TEAM_MESSAGE_CUSTOM_TYPE,
          content: 'raw fallback',
          display: true,
          details: value,
          timestamp: Date.now(),
        },
        options,
        theme,
      );
      expect(component).toBeDefined();
      if (component) expect(rendered(component)).toContain('raw fallback');
    }
  });
});
