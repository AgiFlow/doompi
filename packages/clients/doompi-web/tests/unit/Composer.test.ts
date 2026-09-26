import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/web/components/PluginSurface', () => ({
  PluginSurface: () => createElement('i', { 'data-testid': 'plugin-composer-action' }),
}));

import { Composer } from '../../src/web/features/session/Composer';
import { resetSessions, setActiveSession } from '../../src/web/stores/sessionsStore';
import { applySessionLifecycle, dropSessionStore } from '../../src/web/stores/sessionStore';

afterEach(() => {
  resetSessions();
  dropSessionStore('active-session');
});

describe('Composer plugin actions', () => {
  it('renders one action surface without hiding it at either breakpoint', () => {
    const markup = renderToStaticMarkup(createElement(Composer));

    expect(markup.match(/data-testid="plugin-composer-action"/g)).toHaveLength(1);
    expect(markup).toContain('data-testid="composer-actions"');
    expect(markup).not.toMatch(/data-testid="composer-actions"[^>]*sm:hidden/);
  });

  it('keeps Abort visible and disabled until the server reports terminal ownership', () => {
    setActiveSession('active-session');
    applySessionLifecycle('active-session', {
      revision: 1,
      operation: { id: 'turn-4', kind: 'run', status: 'aborting' },
      paused: true,
      queue: [],
    });
    const aborting = renderToStaticMarkup(createElement(Composer));
    expect(aborting).toContain('data-testid="composer-abort"');
    expect(aborting).toContain('aborting…');
    expect(aborting).toMatch(/data-testid="composer-abort"[^>]*disabled|disabled[^>]*data-testid="composer-abort"/);

    applySessionLifecycle('active-session', { revision: 2, operation: null, paused: true, queue: [] });
    const idle = renderToStaticMarkup(createElement(Composer));
    expect(idle).not.toContain('data-testid="composer-abort"');
    expect(idle).toContain('data-testid="composer-queued"');
  });
});
