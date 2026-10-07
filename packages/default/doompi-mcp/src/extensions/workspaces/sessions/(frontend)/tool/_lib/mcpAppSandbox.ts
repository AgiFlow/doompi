const MAX_CSP_DOMAINS = 64;
const MAX_DOMAIN_LENGTH = 2048;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accept origins only, never CSP tokens, URL paths, credentials, or the host origin. */
function origins(value: unknown, hostOrigin: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CSP_DOMAINS) throw new Error('Invalid widget CSP domains');
  return value.map((domain: unknown) => {
    if (typeof domain !== 'string' || domain.length > MAX_DOMAIN_LENGTH) throw new Error('Invalid widget CSP domain');
    const parsed = new URL(domain);
    const wildcard = parsed.hostname.startsWith('*.');
    const host = new URL(hostOrigin);
    const includesHost =
      parsed.hostname === host.hostname || (wildcard && host.hostname.endsWith(parsed.hostname.slice(1)));
    if (
      !['https:', 'wss:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      includesHost ||
      parsed.hostname === 'localhost' ||
      /^(127\.|0\.|\[?::1\]?)/u.test(parsed.hostname) ||
      /[\s;'"<>]/u.test(domain)
    )
      throw new Error('Unsafe widget CSP domain');
    return parsed.origin;
  });
}

export function mcpAppCsp(metadata: unknown, hostOrigin: string): string {
  const meta = record(metadata);
  const ui = record(meta?.ui);
  if (meta?.ui !== undefined && ui === undefined) throw new Error('Invalid widget UI metadata');
  // A present standard field always wins, including malformed values (fail closed).
  const standard = ui !== undefined && 'csp' in ui;
  const raw = standard ? ui.csp : meta?.['openai/widgetCSP'];
  const csp = raw === undefined ? {} : record(raw);
  if (csp === undefined) throw new Error('Invalid widget CSP');
  const resource = origins(csp[standard ? 'resourceDomains' : 'resource_domains'], hostOrigin).join(' ');
  const connect = origins(csp[standard ? 'connectDomains' : 'connect_domains'], hostOrigin).join(' ');
  // Nested frames, forms, base URLs, workers and navigation privileges are not admitted.
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resource}`,
    `style-src 'unsafe-inline' ${resource}`,
    `img-src data: blob: ${resource}`,
    `font-src data: ${resource}`,
    `media-src blob: ${resource}`,
    `connect-src ${connect || "'none'"}`,
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

type HostTheme = 'light' | 'dark';

/** The theme a host message carries, from either bridge. Serialized into frames, so it stays self-contained. */
export function mcpAppHostTheme(data: unknown): HostTheme | undefined {
  const message = data as {
    channel?: unknown;
    globals?: { theme?: unknown } | null;
    jsonrpc?: unknown;
    method?: unknown;
    params?: { theme?: unknown } | null;
  } | null;
  const theme =
    message?.channel === 'doompi.openai'
      ? message.globals?.theme
      : message?.jsonrpc === '2.0' && message.method === 'ui/notifications/host-context-changed'
        ? message.params?.theme
        : undefined;
  return theme === 'light' || theme === 'dark' ? theme : undefined;
}

/**
 * Bundled trusted code, runs inside the App document. Waits for the App's own
 * <html> attributes, which the parser merges only where the root has none, so
 * an App-chosen class or data-theme wins until the host theme changes.
 */
export function widgetThemeBootstrap(hostTheme: (data: unknown) => HostTheme | undefined, initial: HostTheme): void {
  const root = document.documentElement;
  let theme = initial;
  let changed = false;
  const settle = (): void => {
    if (!root.classList.contains('light') && !root.classList.contains('dark')) root.classList.add(theme);
    if (root.getAttribute('data-theme') === null) root.setAttribute('data-theme', theme);
  };
  const follow = (): void => {
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    const current = root.getAttribute('data-theme');
    if (current === null || current === 'light' || current === 'dark') root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
  };
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const next = event.source === parent ? hostTheme(event.data) : undefined;
    if (next === undefined) return;
    theme = next;
    changed = true;
    if (document.readyState !== 'loading') follow();
  });
  if (document.readyState !== 'loading') settle();
  else
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'interactive') {
        if (changed) follow();
        else settle();
      }
    });
}

/** Bundled trusted code, runs in an opaque relay separate from the untrusted App. */
function relayBootstrap(hostTheme: (data: unknown) => HostTheme | undefined): void {
  let configured = false;
  // The relay canvas must match the App's color scheme or the browser paints it opaque.
  const follow = (data: unknown): void => {
    const theme = hostTheme(data);
    if (theme !== undefined) document.documentElement.style.colorScheme = theme;
  };
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== parent || configured || event.ports.length !== 1) return;
    const config = event.data as { html: string; policy: string; protocol: string };
    if (typeof config?.html !== 'string' || typeof config.policy !== 'string') return;
    configured = true;
    const port = event.ports[0]!;
    const inner = document.createElement('iframe');
    inner.title = 'MCP App content';
    inner.setAttribute('sandbox', 'allow-scripts');
    inner.setAttribute('csp', config.policy);
    inner.setAttribute(
      'allow',
      "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
    );
    inner.style.cssText = 'width:100%;height:100%;border:0;display:block';
    let loaded = false;
    let revoked = false;
    const revoke = (): void => {
      if (revoked) return;
      revoked = true;
      inner.remove();
      port.postMessage({ type: 'revoked' });
      port.close();
    };
    inner.addEventListener('load', () => {
      if (loaded) revoke();
      loaded = true;
    });
    let messageWindow = Date.now();
    let messageCount = 0;
    window.addEventListener('message', (childEvent: MessageEvent<unknown>) => {
      if (revoked || childEvent.source !== inner.contentWindow) return;
      try {
        const encoded = JSON.stringify(childEvent.data);
        if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 65536) return revoke();
        const now = Date.now();
        if (now - messageWindow >= 1000) {
          messageWindow = now;
          messageCount = 0;
        }
        if (++messageCount > 128) return revoke();
      } catch {
        return revoke();
      }
      // window.openai is in every App, so its channel reaches the host port whatever the protocol.
      const openai = (childEvent.data as { channel?: unknown } | null)?.channel === 'doompi.openai';
      if (config.protocol === 'mcp' && !openai) parent.postMessage(childEvent.data, '*');
      else port.postMessage({ type: 'legacy', data: childEvent.data });
    });
    // The parent alone owns the other end of this channel. No origin-based trust.
    port.onmessage = (hostEvent: MessageEvent<unknown>) => {
      if (revoked) return;
      follow(hostEvent.data);
      inner.contentWindow?.postMessage(hostEvent.data, '*');
    };
    window.addEventListener('message', (hostEvent: MessageEvent<unknown>) => {
      if (!revoked && hostEvent.source === parent && config.protocol === 'mcp') {
        const data = hostEvent.data as { jsonrpc?: string } | null;
        if (data?.jsonrpc !== '2.0') return;
        follow(data);
        inner.contentWindow?.postMessage(data, '*');
      }
    });
    port.start();
    inner.srcdoc = config.html;
    document.body.append(inner);
    port.postMessage({ type: 'ready' });
  });
}

export function mcpAppRelayHtml(policy: string, theme: HostTheme = 'light'): string {
  // frame-src allows only srcdoc/about, not a host route or a remote sandbox URL.
  const relayPolicy = policy
    .replace("frame-src 'none'", 'frame-src about:')
    .replace("child-src 'none'", 'child-src about:');
  return `<!doctype html><html style="color-scheme:${theme}"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(relayPolicy)}"><style>html,body{margin:0;height:100%;overflow:hidden}</style><script>(${relayBootstrap.toString()})(${mcpAppHostTheme.toString()})</script>`;
}

/** No host <html> is injected, so the App's own root attributes survive parsing. */
export function mcpAppDocument(html: string, policy: string, bootstrap = '', theme: HostTheme = 'light'): string {
  const themeScript = `<script>(${widgetThemeBootstrap.toString()})(${mcpAppHostTheme.toString()}, ${JSON.stringify(theme)})</script>`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><meta name="color-scheme" content="${theme}">${themeScript}${bootstrap}${html}`;
}

/** Required CSP enforcement must survive self-navigation, not only initial srcdoc. */
export function supportsMcpAppSandbox(): boolean {
  return typeof HTMLIFrameElement !== 'undefined' && 'csp' in HTMLIFrameElement.prototype;
}
