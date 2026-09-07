/**
 * Where the hub receives OAuth redirects on behalf of package APIs.
 *
 * Deliberately outside `/api/`. The tunnel guard only lets GET and HEAD through
 * to non-`/api/` paths without the sealed gateway, and an authorization server
 * redirecting a browser cannot speak that gateway. A paired device still
 * authenticates itself here, because the device cookie is `SameSite=Lax` and so
 * rides a top-level cross-site redirect back to the tunnel origin.
 */
export const MCP_OAUTH_CALLBACK_ROUTE = '/mcp-oauth/callback';
