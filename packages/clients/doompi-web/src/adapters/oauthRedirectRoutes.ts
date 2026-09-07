import type { Hono } from 'hono';
import type { OAuthRedirectRegistry } from '../services/oauthRedirectRegistry.ts';
import { MCP_OAUTH_CALLBACK_ROUTE } from '../types/mcpOAuth.ts';

/** Terminal page for the tab the authorization server redirected. */
function page(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.5">
<h1 style="font-size:1rem">${title}</h1>
<p style="font-size:0.875rem;color:#555">${detail}</p>
</body>
</html>`;
}

/**
 * Receives OAuth redirects on the hub's own listener.
 *
 * Only a state some flow already reserved is accepted, so a caller that reaches
 * this route without one changes nothing and is told so. The route is mounted
 * outside `/api/` because the tunnel guard requires the sealed gateway for
 * `/api/` requests, which a redirected browser cannot use.
 */
export function registerOAuthRedirectRoutes(app: Hono, registry: OAuthRedirectRegistry): void {
  app.get(MCP_OAUTH_CALLBACK_ROUTE, (context) => {
    const error = context.req.query('error');
    if (error !== undefined && error !== '') {
      const description = context.req.query('error_description') ?? error;
      return context.html(page('Authorization refused', description), 400);
    }

    const code = context.req.query('code');
    const state = context.req.query('state');
    if (code === undefined || code === '' || state === undefined || state === '') {
      return context.html(page('Not an authorization redirect', 'This link needs a code and a state.'), 400);
    }

    if (registry.deliver({ code, state }) === 'unknown_state') {
      return context.html(
        page('No sign-in is waiting for this', 'The attempt may have expired, been cancelled, or already finished.'),
        404,
      );
    }

    return context.html(page('Signed in', 'You can close this tab and return to DoomPi.'));
  });
}
