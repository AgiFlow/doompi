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

/** Bundled trusted code, runs in an opaque relay separate from the untrusted App. */
function relayBootstrap(): void {
  let configured = false;
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
      if (config.protocol === 'mcp') parent.postMessage(childEvent.data, '*');
      else port.postMessage({ type: 'legacy', data: childEvent.data });
    });
    // The parent alone owns the other end of this channel. No origin-based trust.
    port.onmessage = (hostEvent: MessageEvent<unknown>) => {
      if (revoked) return;
      inner.contentWindow?.postMessage(hostEvent.data, '*');
    };
    window.addEventListener('message', (hostEvent: MessageEvent<unknown>) => {
      if (!revoked && hostEvent.source === parent && config.protocol === 'mcp') {
        const data = hostEvent.data as { jsonrpc?: string } | null;
        if (data?.jsonrpc === '2.0') inner.contentWindow?.postMessage(data, '*');
      }
    });
    port.start();
    inner.srcdoc = config.html;
    document.body.append(inner);
    port.postMessage({ type: 'ready' });
  });
}

export function mcpAppRelayHtml(policy: string): string {
  // frame-src allows only srcdoc/about, not a host route or a remote sandbox URL.
  const relayPolicy = policy
    .replace("frame-src 'none'", 'frame-src about:')
    .replace("child-src 'none'", 'child-src about:');
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(relayPolicy)}"><style>html,body{margin:0;height:100%;overflow:hidden}</style><script>(${relayBootstrap.toString()})()</script>`;
}

export function mcpAppDocument(html: string, policy: string, bootstrap = ''): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">${bootstrap}${html}`;
}

/** Required CSP enforcement must survive self-navigation, not only initial srcdoc. */
export function supportsMcpAppSandbox(): boolean {
  return typeof HTMLIFrameElement !== 'undefined' && 'csp' in HTMLIFrameElement.prototype;
}
