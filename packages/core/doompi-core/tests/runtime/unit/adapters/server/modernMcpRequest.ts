/** The only MCP revision the session endpoint serves. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** The per-request envelope every 2026-07-28 request carries in `params._meta`. */
export const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'session-mcp-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/**
 * Rewrites a posted JSON-RPC request into the 2026-07-28 wire form: the envelope merged into
 * `params._meta` (keeping any metadata the test set, such as a conversation id) and the protocol,
 * method and name headers the server cross-checks against the body.
 */
export async function modernMcpRequest(request: Request): Promise<Request> {
  const message = JSON.parse(await request.clone().text()) as { method: string; params?: Record<string, unknown> };
  const params = message.params ?? {};
  const meta = typeof params._meta === 'object' && params._meta !== null ? params._meta : {};
  const headers = new Headers(request.headers);
  headers.set('mcp-protocol-version', MODERN_PROTOCOL_VERSION);
  headers.set('mcp-method', message.method);
  const name = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : undefined;
  if (name !== undefined) headers.set('mcp-name', name);
  return new Request(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
    body: JSON.stringify({ ...message, params: { ...params, _meta: { ...MODERN_ENVELOPE, ...meta } } }),
  });
}
