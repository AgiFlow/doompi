import type { Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { McpOverlayComponent } from '../src/tui/mcpOverlay.ts';
import type { McpOverlayTarget, McpServerView } from '../src/types/mcp.ts';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

function server(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    name: 'pencil',
    state: 'connected',
    tools: [{ piName: 'pencil_get_screenshot', toolName: 'get_screenshot', description: 'Shoots it', active: true }],
    resourceCount: 0,
    enabled: true,
    ...overrides,
  };
}

function createOverlay(servers: readonly McpServerView[] = [server()]) {
  let current = servers;
  const listeners = new Set<() => void>();
  const target = {
    getSnapshot: vi.fn(() => ({ servers: [] })),
    getDiagnostics: vi.fn(() => []),
    reauthorize: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    openAuthorizationPage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    getServers: vi.fn(() => current),
    setEnabled: vi.fn((name: string, enabled: boolean) => {
      current = current.map((entry) => (entry.name === name ? { ...entry, enabled } : entry));
    }),
    listResources: vi.fn().mockResolvedValue([{ uri: 'pencil://canvas', name: 'canvas', mimeType: 'image/png' }]),
    onChange: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } satisfies McpOverlayTarget as McpOverlayTarget & { [K in keyof McpOverlayTarget]: ReturnType<typeof vi.fn> };
  const tui = { terminal: { rows: 24, columns: 120 }, requestRender: vi.fn() };
  const done = vi.fn();
  const overlay = new McpOverlayComponent(tui, theme, target, done);
  return {
    overlay,
    target,
    tui,
    done,
    emitChange: () => {
      for (const listener of listeners) listener();
    },
  };
}

/** Lets the promise an action kicked off settle before the next assertion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('McpOverlayComponent', () => {
  describe('roster', () => {
    it('lists every server with its state and what it offers', () => {
      const { overlay } = createOverlay([
        server(),
        server({ name: 'boomlink', state: 'needs-auth', tools: [], error: 'authorization required' }),
      ]);

      const rendered = overlay.render(120).join('\n');

      expect(rendered).toContain('MCP');
      expect(rendered).toContain('1/2 connected');
      expect(rendered).toContain('pencil');
      expect(rendered).toContain('boomlink');
      expect(rendered).toContain('needs-auth');
      expect(rendered).toContain('get_screenshot');
    });

    it('renders an empty session without reaching past the end of the roster', () => {
      const { overlay } = createOverlay([]);

      expect(() => overlay.render(120)).not.toThrow();
      expect(overlay.render(120).join('\n')).toContain('No MCP servers are configured');
    });

    it('moves the cursor and clamps it at both ends', () => {
      const { overlay } = createOverlay([server(), server({ name: 'boomlink', state: 'failed', tools: [] })]);

      overlay.handleInput('[B');
      expect(overlay.render(120).join('\n')).toContain('› ');
      overlay.handleInput('[B');
      overlay.handleInput('[B');

      // Still on the last server rather than off the end of the list.
      expect(overlay.render(120)).toHaveLength(24);
    });

    // A twelve-tool server overflows the pane, so the keys that reach the rest of
    // it have to be advertised or they may as well not exist.
    it('advertises canonical list and detail keys in full and compact chrome', () => {
      const { overlay, tui } = createOverlay();

      const full = overlay.render(200).join('\n');
      tui.terminal.rows = 5;
      const compact = overlay.render(200).join('\n');

      for (const rendered of [full, compact]) {
        expect(rendered).toContain('↑↓');
        expect(rendered).toContain('JK');
        expect(rendered).toContain('scroll');
        expect(rendered).not.toContain('⇧JK');
        expect(rendered).not.toContain('J/K');
      }
    });

    it('scrolls the detail pane without moving the server selection', () => {
      const tools = Array.from({ length: 60 }, (_, index) => ({
        piName: `pencil_tool_${index}`,
        toolName: `tool_${index}`,
        active: true,
      }));
      const { overlay } = createOverlay([server({ tools }), server({ name: 'boomlink', tools: [] })]);
      const before = overlay.render(120).join('\n');

      overlay.handleInput('J');
      const after = overlay.render(120).join('\n');

      expect(after).not.toEqual(before);
      // Still on the first server: shift+J scrolls, it does not select.
      expect(after).toContain('› ');
      expect(after).toContain('pencil');
    });

    it('closes on escape', () => {
      const { overlay, done } = createOverlay();

      overlay.handleInput('');

      expect(done).toHaveBeenCalledWith(undefined);
    });
  });

  describe('enable and disable', () => {
    it('disables the selected server for the session', () => {
      const { overlay, target } = createOverlay();

      overlay.handleInput('d');

      expect(target.setEnabled).toHaveBeenCalledWith('pencil', false);
      expect(overlay.render(120).join('\n')).toContain('tools withheld for this session');
    });

    // Unavailable controls stay listed rather than disappearing, so the key map
    // never shifts; pressing one has to say why instead of doing nothing.
    it('explains why enable does nothing on a server that is already enabled', () => {
      const { overlay, target } = createOverlay();

      overlay.handleInput('e');

      expect(target.setEnabled).not.toHaveBeenCalled();
      expect(overlay.render(120).join('\n')).toContain('enable unavailable · pencil is already enabled');
    });

    it('offers enable, and only enable, once a server is disabled', () => {
      const { overlay, target } = createOverlay([server({ enabled: false })]);

      overlay.handleInput('d');
      expect(target.setEnabled).not.toHaveBeenCalled();
      overlay.handleInput('a');
      expect(target.reauthorize).not.toHaveBeenCalled();

      overlay.handleInput('e');

      expect(target.setEnabled).toHaveBeenCalledWith('pencil', true);
    });
  });

  describe('auth', () => {
    it('reauthorizes the selected server', async () => {
      const { overlay, target } = createOverlay([server({ state: 'needs-auth', tools: [] })]);

      overlay.handleInput('a');
      await settle();

      expect(target.reauthorize).toHaveBeenCalledWith('pencil');
      expect(overlay.render(120).join('\n')).toContain('auth pencil · authorized');
    });

    it('reports a failure rather than swallowing it', async () => {
      const { overlay, target } = createOverlay([server({ state: 'needs-auth', tools: [] })]);
      target.reauthorize.mockRejectedValue(new Error('runtime has not started'));

      overlay.handleInput('a');
      await settle();

      expect(overlay.render(120).join('\n')).toContain('auth pencil · failed · runtime has not started');
    });

    it('reopens a pending authorization page without restarting its flow', async () => {
      const { overlay, target } = createOverlay([
        server({ state: 'connecting', authorizationUrl: 'https://auth.example.test/pending' }),
      ]);

      overlay.handleInput('a');
      await settle();

      expect(target.openAuthorizationPage).toHaveBeenCalledWith('pencil');
      expect(target.reauthorize).not.toHaveBeenCalled();
      expect(overlay.render(120).join('\n')).toContain('browser opened · waiting for approval');
    });

    it('keeps the pending page available when the browser cannot be launched', async () => {
      const { overlay, target } = createOverlay([
        server({ state: 'connecting', authorizationUrl: 'https://auth.example.test/pending' }),
      ]);
      target.openAuthorizationPage.mockRejectedValue(new Error('no desktop browser'));

      overlay.handleInput('a');
      await settle();

      expect(overlay.render(120).join('\n')).toContain('browser failed · no desktop browser');
      expect(overlay.render(120).join('\n')).toContain('Open authorization page');
    });

    // Reauthorizing disconnects first, which would tear down a connect in flight.
    it('is withheld while a server is still connecting without a pending page', () => {
      const { overlay, target } = createOverlay([server({ state: 'connecting' })]);

      overlay.handleInput('a');

      expect(target.reauthorize).not.toHaveBeenCalled();
      expect(overlay.render(120).join('\n')).toContain('auth unavailable · pencil is connecting');
    });
  });

  describe('resources', () => {
    it('lists them once when the pane is opened, and not again on the way back', async () => {
      const { overlay, target } = createOverlay();

      overlay.handleInput('\t');
      await settle();

      expect(target.listResources).toHaveBeenCalledTimes(1);
      expect(overlay.render(120).join('\n')).toContain('canvas');

      overlay.handleInput('\t');
      overlay.handleInput('\t');
      await settle();

      expect(target.listResources).toHaveBeenCalledTimes(1);
    });

    // Switching panes must not turn into a silent dial-out.
    it('does not list them for a server that has not connected', async () => {
      const { overlay, target } = createOverlay([server({ state: 'not-connected', tools: [] })]);

      overlay.handleInput('\t');
      await settle();

      expect(target.listResources).not.toHaveBeenCalled();
      expect(overlay.render(120).join('\n')).toContain('press ctrl+r to try anyway');
    });

    it('re-dials on ctrl+r', async () => {
      const { overlay, target } = createOverlay();
      overlay.handleInput('\t');
      await settle();

      overlay.handleInput('');
      await settle();

      expect(target.listResources).toHaveBeenLastCalledWith('pencil', { refresh: true });
    });

    it('shows why a listing failed', async () => {
      const { overlay, target } = createOverlay();
      target.listResources.mockRejectedValue(new Error('method not found'));

      overlay.handleInput('\t');
      await settle();

      expect(overlay.render(120).join('\n')).toContain('Could not list resources: method not found');
    });
  });

  describe('reload', () => {
    it('reconnects every server without waiting on any of them', async () => {
      const { overlay, target } = createOverlay();

      overlay.handleInput('r');

      expect(target.start).toHaveBeenCalled();
      await settle();
      expect(overlay.render(120).join('\n')).toContain('reload · reconnecting');
    });
  });

  // The overlay is fullscreen, so a URL announced through the transcript lands
  // underneath it and the flow cannot be completed from where it was started.
  describe('authorization url', () => {
    const URL = 'https://boomlink.example/oauth/authorize?client_id=abc&state=xyz';

    it('shows a compact clickable fallback for the page the browser opened', () => {
      const { overlay } = createOverlay([server({ state: 'connecting', authorizationUrl: URL })]);

      const rendered = overlay.render(200).join('\n');

      expect(rendered).toContain('Authorization page ready');
      expect(rendered).toContain('Open authorization page');
      expect(rendered).toContain(URL);
    });

    it('keeps a long url in one hyperlink target instead of wrapping printable text', () => {
      const long = `https://boomlink.example/oauth/authorize?${'p'.repeat(300)}`;
      const { overlay } = createOverlay([server({ state: 'connecting', authorizationUrl: long })]);

      const rendered = overlay.render(80);
      const targetLines = rendered.filter((line) => line.includes(long));

      expect(targetLines).toHaveLength(1);
      expect(targetLines[0]).toContain('Open authorization page');
    });

    it('says nothing when no flow is waiting', () => {
      const { overlay } = createOverlay();

      expect(overlay.render(200).join('\n')).not.toContain('Open authorization page');
    });

    it('stops claiming to be dispatching once the url arrives', () => {
      const servers = [server({ state: 'connecting' })];
      const { overlay, target, emitChange } = createOverlay(servers);
      overlay.handleInput('a');
      target.getServers.mockReturnValue([{ ...servers[0], authorizationUrl: URL }]);

      emitChange();

      expect(overlay.render(200).join('\n')).toContain('page ready · a reopens browser');
    });
  });

  describe('staying current', () => {
    it('repaints when the session says the picture changed', () => {
      const { tui, emitChange } = createOverlay();
      tui.requestRender.mockClear();

      emitChange();

      expect(tui.requestRender).toHaveBeenCalled();
    });

    it('stops listening once disposed', () => {
      const { overlay, tui, emitChange } = createOverlay();

      overlay.dispose();
      tui.requestRender.mockClear();
      emitChange();

      expect(tui.requestRender).not.toHaveBeenCalled();
    });
  });
});
