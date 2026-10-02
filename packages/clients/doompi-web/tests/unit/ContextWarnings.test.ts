import { CONTEXT_TOOL_WARNINGS_STATUS_KEY } from '@agimon-ai/doompi-core/contextApi';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/web/components/PluginSurface', () => ({ PluginSurface: () => null }));
vi.mock('@agimon-ai/doompi-web-components', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const wrapper = ({ children }: { children: React.ReactNode }) => createElement('div', null, children);
  return {
    ...original,
    Dialog: wrapper,
    DialogContent: wrapper,
    DialogHeader: wrapper,
    DialogBody: wrapper,
    DialogTitle: wrapper,
  };
});

import { contextProjection } from '../../src/web/features/activity/context.fixture';
import { ContextItemDialog } from '../../src/web/features/activity/ContextItemDialog';
import { ContextPanel } from '../../src/web/features/activity/ContextPanel';
import { resetSessions, setActiveSession } from '../../src/web/stores/sessionsStore';
import { dropSessionStore, sessionStoreFor } from '../../src/web/stores/sessionStore';

const warning = { source: 'server/tool (call)', path: 'input.type', message: 'Unsupported type' };

afterEach(() => {
  resetSessions();
  dropSessionStore('warning-session');
  dropSessionStore('clean-session');
});

describe('context warning display', () => {
  it('badges affected tools without disabling rows and follows active-session status', () => {
    setActiveSession('warning-session');
    sessionStoreFor('warning-session').setState((state) => ({
      ...state,
      context: contextProjection,
      statuses: { [CONTEXT_TOOL_WARNINGS_STATUS_KEY]: JSON.stringify({ read: [warning] }) },
    }));
    const warned = renderToStaticMarkup(createElement(ContextPanel));
    expect(warned).toContain('aria-label="read has warnings"');
    expect(warned).toContain('data-testid="context-row-read"');
    expect(warned).not.toMatch(/<button[^>]*\sdisabled(?:=|\s|>)/);
    sessionStoreFor('warning-session').setState((state) => ({ ...state, statuses: {} }));
    expect(renderToStaticMarkup(createElement(ContextPanel))).not.toContain('context-warning-read');
    sessionStoreFor('warning-session').setState((state) => ({
      ...state,
      statuses: { [CONTEXT_TOOL_WARNINGS_STATUS_KEY]: JSON.stringify({ read: [warning] }) },
    }));
    setActiveSession('clean-session');
    sessionStoreFor('clean-session').setState((state) => ({ ...state, context: contextProjection }));
    expect(renderToStaticMarkup(createElement(ContextPanel))).not.toContain('context-warning-read');
  });
  it.each([undefined, '{}', JSON.stringify({ read: [warning] })])(
    'does not inherit warning entries for a tool named constructor (%s)',
    (raw) => {
      setActiveSession('warning-session');
      const statuses: Record<string, string> = {};
      if (raw !== undefined) statuses[CONTEXT_TOOL_WARNINGS_STATUS_KEY] = raw;
      sessionStoreFor('warning-session').setState((state) => ({
        ...state,
        context: {
          ...contextProjection,
          groups: contextProjection.groups.map((group) => ({
            ...group,
            items: group.items.map((item) => (item.name === 'read' ? { ...item, name: 'constructor' } : item)),
          })),
        },
        statuses,
      }));
      const markup = renderToStaticMarkup(createElement(ContextPanel));
      expect(markup).toContain('context-row-constructor');
      expect(markup).not.toContain('context-warning-constructor');
    },
  );

  it('renders live origins independently of loaded detail and removes cleared warnings', () => {
    const props = {
      sessionId: 'warning-session',
      target: { itemKind: 'tool' as const, name: 'read', owner: 'owner' },
      onClose: () => undefined,
    };
    const markup = renderToStaticMarkup(createElement(ContextItemDialog, { ...props, warnings: [warning] }));
    expect(markup).toContain('context-item-loading');
    expect(markup).toContain(warning.source);
    expect(markup).toContain(warning.path);
    expect(markup).toContain(warning.message);
    expect(renderToStaticMarkup(createElement(ContextItemDialog, props))).not.toContain('context-item-warnings');
  });
});
