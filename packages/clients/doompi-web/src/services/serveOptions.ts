import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';

export interface ServeOptions {
  /** Registry override; the default is resolved by the caller. */
  registryDir?: string;
  /** Command launching created sessions; the caller resolves one when this is absent. */
  spawnCommand?: string;
  port: number;
  host: string;
  assetsDir?: string;
  /** Repository composition to sync, watch, and serve explicitly. */
  directory?: string;
  /** Where remote-access settings and the tunnel pid file live; the caller resolves a default. */
  stateDir?: string;
  /** Explicit cloudflared binary, ahead of DOOMPI_CLOUDFLARED and a PATH scan. */
  cloudflaredPath?: string;
  help: boolean;
  version: boolean;
}

/** Addresses that keep the cockpit off the network; anything else needs saying out loud. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

const DEFAULT_PORT = 7433;
const DEFAULT_HOST = '127.0.0.1';

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
  return value;
}

/** Every flag takes a value except help and version, both of which have the usual short form. */
const OPTIONS = {
  dir: { type: 'string' },
  'registry-dir': { type: 'string' },
  'spawn-command': { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  assets: { type: 'string' },
  'state-dir': { type: 'string' },
  cloudflared: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const satisfies ParseArgsOptionsConfig;

/**
 * Parses the doompi-web command line.
 *
 * Every flag is an override. Bare `doompi-web` is a hub over the default
 * registry directory on the default loopback port, which is the way it is
 * meant to be run; nothing here is required to get a working cockpit.
 */
export function parseServeOptions(argv: readonly string[]): ServeOptions {
  // Non-strict with tokens rather than strict: parseArgs' own errors for an
  // unknown flag read nothing like the rest of this CLI, and the tokens carry
  // everything needed to report them in our own words.
  const { tokens } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    strict: false,
    tokens: true,
    allowPositionals: true,
  });

  const values = new Map<string, string>();
  let help = false;
  let version = false;
  for (const token of tokens) {
    if (token.kind === 'positional') throw new Error(`Unknown option "${token.value}".`);
    if (token.kind !== 'option') continue;
    if (token.name === 'help') {
      help = true;
      continue;
    }
    if (token.name === 'version') {
      version = true;
      continue;
    }
    if (!Object.hasOwn(OPTIONS, token.name)) throw new Error(`Unknown option "${token.rawName}".`);
    values.set(token.name, requireValue(`--${token.name}`, token.value));
  }

  let port = DEFAULT_PORT;
  const rawPort = values.get('port');
  if (rawPort !== undefined) {
    const parsed = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      throw new Error(`--port expects a port number, received "${rawPort}".`);
    }
    port = parsed;
  }

  return {
    registryDir: values.get('registry-dir'),
    spawnCommand: values.get('spawn-command'),
    port,
    host: values.get('host') ?? DEFAULT_HOST,
    assetsDir: values.get('assets'),
    stateDir: values.get('state-dir'),
    directory: values.get('dir'),
    cloudflaredPath: values.get('cloudflared'),
    help,
    version,
  };
}

export function serveHelp(): string {
  return `Usage: doompi-web [options]\n\nOptions:\n  --dir <path>          Pin, sync, and watch one repository composition\n  --registry-dir <path> Session registry (default: ~/.doompi/run)\n  --spawn-command <cmd> Command used to launch sessions\n  --port <number>       HTTP port (default: 7433)\n  --host <address>      Bind address (default: 127.0.0.1)\n  --assets <path>       Override the built SPA directory\n  --state-dir <path>    Remote-access and cockpit state directory\n  --cloudflared <path>  cloudflared binary\n  -h, --help            Show this help\n  -v, --version         Show the package version\n`;
}
