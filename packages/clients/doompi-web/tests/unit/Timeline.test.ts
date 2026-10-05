import { defineWebPlugin, type ToolMessageRenderProps } from '@agimon-ai/doompi-core/web';
import { MessageItem, MessageItemHeader } from '@agimon-ai/doompi-web-components';
import { Store } from '@tanstack/store';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Transcript } from '../../src/web/features/session/Timeline';
import { installWebPlugins, resetWebPlugins } from '../../src/web/lib/pluginRegistry';
import { initialSessionState } from '../../src/web/lib/sessionModel';
import { sessionsStore } from '../../src/web/stores/sessionsStore';
import { sessionStoreFor } from '../../src/web/stores/sessionStore';

vi.mock('../../src/web/features/session/MessageMarkdown', () => ({
  MessageMarkdown: ({ text }: { text: string }) => createElement('span', null, text),
}));

vi.mock('../../src/web/features/session/MentionPreviews', () => ({
  MentionPreviews: () => null,
}));

afterEach(() => {
  resetWebPlugins();
  sessionStoreFor(sessionsStore.state.activeId).setState(() => ({ ...initialSessionState }));
});

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

describe('Timeline persona avatar', () => {
  it('falls back to the fold persona for an assistant entry rebuilt without one', () => {
    const store = new Store({
      ...initialSessionState,
      profileIdentity: { profile: 'ponytail', name: 'Ponytail' },
      entries: [{ kind: 'assistant' as const, id: 'a1', text: 'hi', thinking: '', streaming: false }],
    });

    const markup = renderToStaticMarkup(
      createElement(Transcript, { store, sessionId: 'session-1', empty: createElement('div') }),
    );

    expect(markup).toContain('aria-label="Ponytail"');
  });

  it('keeps the persona a message was written under over the fold persona', () => {
    const store = new Store({
      ...initialSessionState,
      profileIdentity: { profile: 'ponytail', name: 'Ponytail' },
      entries: [
        {
          kind: 'assistant' as const,
          id: 'a1',
          text: 'hi',
          thinking: '',
          streaming: false,
          identity: { profile: 'rhea', name: 'Rhea' },
        },
      ],
    });

    const markup = renderToStaticMarkup(
      createElement(Transcript, { store, sessionId: 'session-1', empty: createElement('div') }),
    );

    expect(markup).toContain('aria-label="Rhea"');
    expect(markup).not.toContain('aria-label="Ponytail"');
  });
});

describe('Timeline tool props', () => {
  it('uses active statuses for renderer selection while binding actions to the transcript session', () => {
    sessionStoreFor('session-bound').setState(() => ({
      ...initialSessionState,
      statuses: { 'doom-mcp': 'github' },
    }));
    const PluginMessage = (props: ToolMessageRenderProps) =>
      createElement('span', {
        'data-testid': 'plugin-tool-message',
        'data-session-id': props.sessionId,
        'data-status': props.statuses['doom-mcp'] ?? 'none',
      });
    installWebPlugins([
      defineWebPlugin({
        id: 'tools',
        toolRenderers: [
          {
            tools: ['exact_tool'],
            message: PluginMessage,
          },
          {
            tools: [],
            matches: (name, statuses) =>
              name === 'github_search' && (statuses['doom-mcp'] ?? '').split(',').includes('github'),
            message: PluginMessage,
          },
        ],
      }),
    ]);
    const store = new Store({
      ...initialSessionState,
      entries: [
        {
          kind: 'tool' as const,
          id: 'exact',
          toolCallId: 'call-exact',
          name: 'exact_tool',
          args: {},
          argSummary: '',
          result: null,
          output: '',
          isError: false,
          running: false,
        },
        {
          kind: 'tool' as const,
          id: 'matched',
          toolCallId: 'call-matched',
          name: 'github_search',
          args: {},
          argSummary: '',
          result: null,
          output: '',
          isError: false,
          running: false,
        },
      ],
    });

    const markup = renderToStaticMarkup(
      createElement(Transcript, {
        store,
        sessionId: 'session-bound',
        empty: createElement('div'),
      }),
    );

    expect(markup).toContain('data-session-id="session-bound"');
    expect(markup).toContain('data-status="none"');
    expect(markup.match(/data-tool-renderer="plugin"/g)).toHaveLength(1);
    expect(markup).toContain('data-tool-name="github_search" data-tool-state="ok" data-tool-renderer="host"');
  });
});

describe('Timeline post-hook badges', () => {
  const entry = (id: string, toolCallId: string) => ({
    kind: 'tool' as const,
    id,
    toolCallId,
    name: 'hook_test_tool',
    args: {},
    argSummary: id,
    result: null,
    output: '',
    isError: false,
    running: false,
  });
  const render = (statuses: Record<string, string>, grouped = false) => {
    sessionStoreFor(sessionsStore.state.activeId).setState(() => ({ ...initialSessionState, statuses }));
    return renderToStaticMarkup(
      createElement(Transcript, {
        store: new Store({
          ...initialSessionState,
          statuses,
          entries: grouped
            ? [entry('entry-first', 'call-first'), entry('entry-second', 'call-second')]
            : [entry('entry-first', 'call-first')],
        }),
        sessionId: 'hook-session',
        empty: createElement('div'),
      }),
    );
  };

  it.each(['host', 'plugin'] as const)('adds the badge to the %s shared header before the outcome', (renderer) => {
    if (renderer === 'plugin')
      installWebPlugins([
        defineWebPlugin({
          id: 'hook-renderer',
          toolRenderers: [
            {
              tools: ['hook_test_tool'],
              message: () =>
                createElement(MessageItem, { tone: 'ok' }, createElement(MessageItemHeader, { title: 'plugin' })),
            },
          ],
        }),
      ]);
    const markup = render({ 'repository-hooks:call-first:post': '  Running post hook: verify repository  ' });
    expect(markup).toContain(`data-tool-renderer="${renderer}"`);
    expect(markup.match(/data-testid="tool-hook-status"/g)).toHaveLength(1);
    expect(markup).toContain('>HOOK</span>');
    expect(markup).toContain('title="Running post hook: verify repository"');
    expect(markup).toContain('aria-label="Running post hook: verify repository"');
    expect(markup.indexOf('data-testid="tool-hook-status"')).toBeLessThan(markup.indexOf('data-testid="tool-status"'));
  });

  it('attributes a grouped badge only to its matching call row', () => {
    const markup = render({ 'repository-hooks:call-second:post': 'second hook' }, true);
    expect(markup).toContain('data-testid="entry-tool-group"');
    const rows = markup.split('data-testid="entry-tool"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toContain('tool-hook-status');
    expect(rows[1]).toContain('data-testid="tool-hook-status"');
    expect(rows[1]).toContain('aria-label="second hook"');
    expect(markup.match(/data-testid="tool-hook-status"/g)).toHaveLength(1);
  });

  it.each<Record<string, string>>([
    {},
    { 'repository-hooks:call-first:post': '' },
    { 'repository-hooks:call-first:post': '  \t ' },
    { 'repository-hooks:call-first:pre': 'pre hook' },
    { 'repository-hooks:other-call:post': 'other hook' },
    { 'repository-hooks:entry-first:post': 'entry id is not call id' },
  ])('omits cleared, blank, pre and unrelated statuses: %j', (statuses) => {
    expect(render(statuses)).not.toContain('tool-hook-status');
  });
});
