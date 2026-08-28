/**
 * Turning a tunnel configuration into a command line, and cloudflared's output
 * back into a public origin.
 *
 * The parsing half only exists for quick tunnels. A named tunnel is configured
 * with its hostname, so nothing has to be scraped and the origin is known
 * before the process starts. That difference is the strongest practical
 * argument for named mode: the banner cloudflared prints is an undocumented
 * detail of its logging, and a release that reformats it breaks quick mode
 * until the readiness deadline fires.
 */

import type { TunnelConfig, TunnelFailure } from '../types/remoteAccess.ts';

/**
 * A trycloudflare hostname, and nothing that merely ends near one.
 *
 * The trailing lookahead is the whole point. Without it,
 * `https://evil.trycloudflare.com.attacker.tld` printed by a confused or
 * hostile process would match, and the extracted value becomes the origin the
 * guard then trusts for every subsequent request.
 */
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.trycloudflare\.com(?![a-z0-9.-])/iu;

/** Cloudflare reports a connection registered; readiness waits for this as well as a URL. */
const CONNECTION_READY = /registered tunnel connection|connection .* registered/iu;

export function tunnelTarget(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

/**
 * The cloudflared argument vector.
 *
 * `--url` is a flag on the `tunnel` command rather than on `run`, so it comes
 * before the subcommand in both shapes. `--token-file` belongs to `run`.
 *
 * Flag placement here follows cloudflared's documented usage and local help.
 */
export function tunnelArgs(config: TunnelConfig, port: number, tokenFile?: string): string[] {
  const args = ['tunnel', '--no-autoupdate'];
  if (config.kind === 'named' && config.configFile !== undefined) args.push('--config', config.configFile);
  args.push('--url', tunnelTarget(port));
  if (config.kind === 'quick') return args;
  args.push('run');
  if (tokenFile !== undefined && tokenFile !== '') args.push('--token-file', tokenFile);
  if (config.name !== undefined) args.push(config.name);
  return args;
}

/** The public origin a quick tunnel announced, or undefined if this output does not carry one. */
export function extractTunnelUrl(text: string): string | undefined {
  return QUICK_TUNNEL_URL.exec(text)?.[0].toLowerCase();
}

export function mentionsRegisteredConnection(text: string): boolean {
  return CONNECTION_READY.test(text);
}

/** Operator-facing copy for a failure, with the cause appended by the caller. */
export function describeTunnelFailure(failure: TunnelFailure): string {
  switch (failure) {
    case 'not_installed':
      return 'cloudflared is not installed. Install it (brew install cloudflared) or set DOOMPI_CLOUDFLARED.';
    case 'spawn_failed':
      return 'cloudflared could not be started.';
    case 'timeout':
      return 'cloudflared did not report a public URL in time.';
    case 'self_test_failed':
      return 'The tunnel came up unguarded and was closed immediately.';
    case 'exited':
      return 'cloudflared stopped on its own.';
  }
}
