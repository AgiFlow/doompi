import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import {
  mcpAppCsp,
  mcpAppDocument,
  mcpAppHostTheme,
  mcpAppRelayHtml,
  widgetThemeBootstrap,
} from '../../src/extensions/workspaces/sessions/(frontend)/tool/_lib/mcpAppSandbox';
import { mcpOpenAiScript } from '../../src/extensions/workspaces/sessions/(frontend)/tool/_lib/mcpOpenAiBootstrap';

const policy = mcpAppCsp({}, 'https://doom.example');
const script = (html: string) => html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

describe('App sandbox protocol guards', () => {
  it('fails closed for unsafe origins and malformed standard policy instead of taking legacy permissions', () => {
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(() =>
      mcpAppCsp(
        { ui: { csp: null }, 'openai/widgetCSP': { connect_domains: ['https://safe.example'] } },
        'https://doom.example',
      ),
    ).toThrow('Invalid');
    for (const origin of [
      'https://doom.example',
      'https://*.example',
      'wss://*.example',
      'HTTPS://*.EXAMPLE',
      'http://safe.example',
      'https://user:password@safe.example',
      'https://safe.example?query',
      'https://safe.example#hash',
      'https://localhost',
      'https://127.0.0.1',
      'https://safe.example; script-src *',
      'https://safe.example/path',
    ]) {
      expect(() => mcpAppCsp({ ui: { csp: { connectDomains: [origin] } } }, 'https://doom.example')).toThrow();
    }
    const html = mcpAppDocument('<script>untrusted()</script>', policy);
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('untrusted()'));
  });

  it('normalizes declared external origins and bounds malformed policies', () => {
    const standard = mcpAppCsp(
      { ui: { csp: { connectDomains: ['wss://safe.example'], resourceDomains: ['https://*.cdn.example'] } } },
      'https://doom.example',
    );
    expect(standard).toContain('connect-src wss://safe.example');
    expect(standard).toContain("script-src 'unsafe-inline' https://*.cdn.example");
    expect(
      mcpAppCsp({ 'openai/widgetCSP': { connect_domains: ['https://api.example'] } }, 'https://doom.example'),
    ).toContain('connect-src https://api.example');
    for (const metadata of [
      { ui: [] },
      { ui: { csp: [] } },
      { ui: { csp: { connectDomains: '*' } } },
      { ui: { csp: { connectDomains: Array(65).fill('https://safe.example') } } },
      { ui: { csp: { connectDomains: [5] } } },
      { ui: { csp: { connectDomains: ['https://' + 'x'.repeat(2049)] } } },
    ]) {
      expect(() => mcpAppCsp(metadata, 'https://doom.example')).toThrow('Invalid');
    }
  });
  it('accepts only its inner frame, limits messages, and revokes a replaced document', () => {
    const setup = () => {
      const listeners: Array<(event: Record<string, unknown>) => void> = [];
      let load = () => undefined;
      const child = {
        contentWindow: {},
        style: {},
        setAttribute: vi.fn(),
        remove: vi.fn(),
        addEventListener: (_: string, handler: () => undefined) => {
          load = handler;
        },
      };
      const parent = { postMessage: vi.fn() };
      const port = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn() };
      const window = {
        addEventListener: (_: string, listener: (event: Record<string, unknown>) => void) => listeners.push(listener),
      };
      runInNewContext(script(mcpAppRelayHtml(policy)), {
        window,
        parent,
        document: { createElement: () => child, body: { append: vi.fn() } },
        TextEncoder,
      });
      const emit = (event: Record<string, unknown>) => [...listeners].forEach((listener) => listener(event));
      emit({ source: parent, data: { html: '<p>app</p>', policy, protocol: 'mcp' }, ports: [port] });
      return { child, parent, port, emit, load: () => load() };
    };
    const f = setup();
    f.emit({ source: {}, data: { jsonrpc: '2.0', id: 1 }, ports: [] });
    expect(f.parent.postMessage).not.toHaveBeenCalled();
    f.emit({ source: f.child.contentWindow, data: { jsonrpc: '2.0', id: 1 }, ports: [] });
    expect(f.parent.postMessage).toHaveBeenCalledOnce();
    f.load();
    f.load();
    expect(f.child.remove).toHaveBeenCalledOnce();
    f.emit({ source: f.child.contentWindow, data: {}, ports: [] });
    expect(f.parent.postMessage).toHaveBeenCalledOnce();

    const oversized = setup();
    oversized.emit({ source: oversized.child.contentWindow, data: 'x'.repeat(65537), ports: [] });
    expect(oversized.port.postMessage).toHaveBeenCalledWith({ type: 'revoked' });
    expect(oversized.parent.postMessage).not.toHaveBeenCalled();
    const flood = setup();
    for (let i = 0; i < 129; i++) flood.emit({ source: flood.child.contentWindow, data: {}, ports: [] });
    expect(flood.child.remove).toHaveBeenCalledOnce();

    const bridged = setup();
    const openai = { channel: 'doompi.openai', id: 1, method: 'callTool', input: { name: 'app_data' } };
    bridged.emit({ source: bridged.child.contentWindow, data: openai, ports: [] });
    expect(bridged.port.postMessage).toHaveBeenCalledWith({ type: 'legacy', data: openai });
    expect(bridged.parent.postMessage).not.toHaveBeenCalled();
    bridged.emit({ source: bridged.child.contentWindow, data: { jsonrpc: '2.0', id: 2 }, ports: [] });
    expect(bridged.parent.postMessage).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 2 }, '*');
    bridged.emit({
      source: bridged.child.contentWindow,
      data: { channel: 'doompi.openai', input: 'x'.repeat(65537) },
      ports: [],
    });
    expect(bridged.port.postMessage).toHaveBeenLastCalledWith({ type: 'revoked' });
    expect(bridged.port.postMessage).toHaveBeenCalledTimes(3);
  });

  it('sets the relay color scheme and follows live host themes on both channels', () => {
    const listeners: Array<(event: Record<string, unknown>) => void> = [];
    const relay = mcpAppRelayHtml(policy, 'dark');
    expect(relay).toContain('<html style="color-scheme:dark">');
    const child = {
      contentWindow: { postMessage: vi.fn() },
      style: {},
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
    };
    const parent = { postMessage: vi.fn() };
    const port: Record<string, unknown> = { postMessage: vi.fn(), close: vi.fn(), start: vi.fn() };
    const root = { style: { colorScheme: 'dark' } };
    runInNewContext(script(relay), {
      window: {
        addEventListener: (_: string, listener: (event: Record<string, unknown>) => void) => listeners.push(listener),
      },
      parent,
      document: { createElement: () => child, body: { append: vi.fn() }, documentElement: root },
      TextEncoder,
    });
    const emit = (event: Record<string, unknown>) => [...listeners].forEach((listener) => listener(event));
    emit({ source: parent, data: { html: '<p>app</p>', policy, protocol: 'mcp' }, ports: [port] });
    (port.onmessage as (event: unknown) => void)({ data: { channel: 'doompi.openai', globals: { theme: 'light' } } });
    expect(root.style.colorScheme).toBe('light');
    emit({
      source: parent,
      data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } },
      ports: [],
    });
    expect(root.style.colorScheme).toBe('dark');
    (port.onmessage as (event: unknown) => void)({ data: { channel: 'doompi.openai', globals: { theme: 'sepia' } } });
    expect(root.style.colorScheme).toBe('dark');
  });

  it('themes the widget root without overriding its own class or data-theme, then syncs live', () => {
    const html = mcpAppDocument('<p>app</p>', policy, '', 'dark');
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
    expect(html).not.toContain('<html');
    // Serialized runs prove the frame script is self-contained; direct runs let coverage see the rules.
    const boot = (classes: string[], dataTheme: string | null, serialized = false, readyState = 'loading') => {
      const listeners: Array<(event: Record<string, unknown>) => void> = [];
      const ready: Array<() => void> = [];
      const attributes = new Map<string, string>(dataTheme === null ? [] : [['data-theme', dataTheme]]);
      const names = new Set(classes);
      const root = {
        classList: {
          contains: (name: string) => names.has(name),
          add: (name: string) => names.add(name),
          remove: (...remove: string[]) => remove.forEach((name) => names.delete(name)),
        },
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        style: { colorScheme: '' },
      };
      const parent = {};
      const document = {
        readyState,
        documentElement: root,
        addEventListener: (_: string, listener: () => void) => ready.push(listener),
      };
      const globals = {
        window: {
          addEventListener: (_: string, listener: (event: Record<string, unknown>) => void) => listeners.push(listener),
        },
        parent,
        document,
      };
      if (serialized) runInNewContext(script(html), globals);
      else {
        for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
        widgetThemeBootstrap(mcpAppHostTheme, 'dark');
      }
      return {
        names,
        attributes,
        root,
        interactive: (state = 'interactive') => {
          document.readyState = state;
          ready.forEach((listener) => listener());
        },
        send: (data: unknown, source: unknown = parent) => listeners.forEach((listener) => listener({ source, data })),
      };
    };

    const owned = boot(['light'], 'brand');
    owned.interactive();
    owned.interactive('complete');
    expect([...owned.names]).toEqual(['light']);
    expect(owned.attributes.get('data-theme')).toBe('brand');
    owned.send({ channel: 'doompi.openai', globals: { theme: 'dark' } });
    expect([...owned.names]).toEqual(['dark']);
    expect(owned.attributes.get('data-theme')).toBe('brand');
    expect(owned.root.style.colorScheme).toBe('dark');

    const plain = boot([], null, true);
    plain.interactive();
    expect([...plain.names]).toEqual(['dark']);
    expect(plain.attributes.get('data-theme')).toBe('dark');
    plain.send({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
    expect([...plain.names]).toEqual(['light']);
    expect(plain.attributes.get('data-theme')).toBe('light');
    plain.send({ channel: 'doompi.openai', globals: { theme: 'dark' } }, {});
    expect([...plain.names]).toEqual(['light']);

    for (const classes of [[], ['dark']]) {
      const early = boot(classes, null, true);
      early.send({ channel: 'doompi.openai', globals: { theme: 'light' } });
      expect([...early.names]).toEqual(classes);
      early.interactive();
      expect([...early.names]).toEqual(['light']);
      expect(early.attributes.get('data-theme')).toBe('light');
      expect(early.root.style.colorScheme).toBe('light');
    }

    const parsed = boot([], 'brand', false, 'complete');
    expect([...parsed.names]).toEqual(['dark']);
    parsed.send({ channel: 'doompi.openai', globals: { theme: 'light' } });
    expect([...parsed.names]).toEqual(['light']);
    expect(parsed.attributes.get('data-theme')).toBe('brand');
    vi.unstubAllGlobals();

    for (const message of [
      null,
      'dark',
      { channel: 'doompi.openai', globals: null },
      { channel: 'doompi.openai', globals: { theme: 'sepia' } },
      { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { theme: 'dark' } },
      { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: null },
    ]) {
      expect(mcpAppHostTheme(message)).toBeUndefined();
    }
  });

  it('bootstraps private globals before scripts, publishes state immediately, and reports the actual display mode', async () => {
    const listeners: Array<(event: Record<string, unknown>) => void> = [];
    const events: unknown[] = [];
    const parent = { postMessage: vi.fn() };
    const window: Record<string, unknown> = {
      addEventListener: (_: string, listener: (event: Record<string, unknown>) => void) => listeners.push(listener),
      dispatchEvent: (event: unknown) => events.push(event),
      setTimeout: () => 1,
    };
    runInNewContext(
      script(
        mcpOpenAiScript({
          toolInput: {},
          toolOutput: false,
          toolResponseMetadata: { private: '</script>sentinel' },
          widgetState: null,
          theme: 'dark',
          locale: 'en',
          displayMode: 'inline',
          maxHeight: 1200,
          userAgent: { device: { type: 'desktop' }, capabilities: { hover: true, touch: false } },
          safeArea: { insets: { top: 0, right: 0, bottom: 0, left: 0 } },
        }),
      ),
      { window, parent, document: { addEventListener: vi.fn() }, CustomEvent, clearTimeout: vi.fn() },
    );
    const api = window.openai as {
      toolOutput: unknown;
      toolResponseMetadata: unknown;
      widgetState: unknown;
      setWidgetState(state: unknown): Promise<unknown>;
      requestDisplayMode(input: unknown): Promise<unknown>;
    };
    expect(api.toolOutput).toBe(false);
    expect(api.toolResponseMetadata).toEqual({ private: '</script>sentinel' });
    const saved = api.setWidgetState({ page: 2 });
    expect(api.widgetState).toEqual({ page: 2 });
    expect(events).toHaveLength(1);
    listeners.forEach((listener) =>
      listener({ source: parent, data: { channel: 'doompi.openai', id: 1, result: {} } }),
    );
    await saved;
    expect(await api.requestDisplayMode({ mode: 'fullscreen' })).toEqual({ mode: 'inline' });
  });
});
