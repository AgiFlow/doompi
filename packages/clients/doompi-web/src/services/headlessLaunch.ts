/** Default client-neutral endpoint the presentation process proxies to. */
export const DEFAULT_HEADLESS_URL = 'http://127.0.0.1:7434';

/** Overrides the resolved `doompi-server` entry, used by packaged clients. */
export const HEADLESS_COMMAND_ENV = 'DOOMPI_SERVER_COMMAND';

/** Session name reported by a headless process the presentation server owns. */
export const HEADLESS_SESSION_NAME = 'DoomPi Web';

/**
 * Decides whether this process should own a headless child.
 *
 * A caller that names an endpoint or a credential is pointing at a headless
 * process someone else runs, so the presentation server only proxies there.
 */
export function ownsHeadlessProcess(options: { headlessUrl?: string; headlessToken?: string }): boolean {
  return (
    (options.headlessUrl === undefined || options.headlessUrl === '') &&
    (options.headlessToken === undefined || options.headlessToken === '')
  );
}

/** Reads the loopback host and port a headless URL listens on. */
export function headlessEndpoint(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`The headless endpoint must be HTTP or HTTPS, received "${url}".`);
  }
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number.parseInt(parsed.port, 10);
  return { host: parsed.hostname, port };
}

/** The argv for a headless process the presentation server starts for itself. */
export function headlessArguments(plan: { entry: string; port: number; tokenFile: string }): string[] {
  return [
    plan.entry,
    '--auth-token-file',
    plan.tokenFile,
    '--no-session',
    '--name',
    HEADLESS_SESSION_NAME,
    '--web',
    String(plan.port),
  ];
}
