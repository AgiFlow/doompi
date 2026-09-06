import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { Store } from '@tanstack/store';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Transcript } from '../../src/web/features/session/Timeline.tsx';
import { initialSessionState } from '../../src/web/lib/sessionModel.ts';
import { installWebPlugins, resetWebPlugins } from '../../src/web/lib/pluginRegistry.ts';

vi.mock('../../src/web/features/session/MessageMarkdown.tsx', () => ({
  MessageMarkdown: ({ text }: { text: string }) => createElement('span', null, text),
}));

vi.mock('../../src/web/features/session/MentionPreviews.tsx', () => ({
  MentionPreviews: () => null,
}));

afterEach(() => resetWebPlugins());

describe('Timeline user-message actions', () => {
  it('renders contributed actions only for user entries with nonempty text and keeps message controls', () => {
    installWebPlugins([
      defineWebPlugin({
        id: 'capture',
        userMessageActions: [
          {
            id: 'save',
            label: 'Save prompt',
            icon: () => createElement('svg', { 'data-testid': 'save-prompt-icon' }),
            run: () => undefined,
          },
        ],
      }),
    ]);
    const store = new Store({
      ...initialSessionState,
      entries: [
        { kind: 'user' as const, id: 'user-text', text: 'capture me' },
        { kind: 'user' as const, id: 'user-image', text: '', images: [{ mimeType: 'image/png', data: 'cG5n' }] },
        { kind: 'user' as const, id: 'user-whitespace', text: '   ' },
        { kind: 'assistant' as const, id: 'assistant', text: 'capture me', thinking: '', streaming: false },
      ],
    });

    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        store,
        sessionId: 'session-1',
        empty: createElement('div'),
      }),
    );

    expect(markup.match(/data-testid="entry-plugin-action"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Save prompt"');
    expect(markup).toContain('title="Save prompt"');
    expect(markup).toContain('data-testid="save-prompt-icon"');
    expect(markup).not.toContain('>Save prompt<');
    expect(markup.match(/data-testid="entry-rewind"/g)).toHaveLength(4);
    expect(markup.match(/data-testid="entry-quote"/g)).toHaveLength(4);
  });
});
