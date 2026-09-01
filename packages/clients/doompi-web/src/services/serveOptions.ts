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

function inlineValue(flag: string, prefix: string): string | undefined {
  if (!flag.startsWith(prefix)) return undefined;
  return requireValue(prefix.slice(0, -1), flag.slice(prefix.length));
}

/**
 * Parses the doompi-web command line.
 *
 * Every flag is an override. Bare `doompi-web` is a hub over the default
 * registry directory on the default loopback port, which is the way it is
 * meant to be run; nothing here is required to get a working cockpit.
 */
export function parseServeOptions(argv: readonly string[]): ServeOptions {
  let registryDir: string | undefined;
  let spawnCommand: string | undefined;
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let assetsDir: string | undefined;
  let stateDir: string | undefined;
  let directory: string | undefined;
  let cloudflaredPath: string | undefined;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const inlineDirectory = inlineValue(flag, '--dir=');
    if (inlineDirectory !== undefined) {
      directory = inlineDirectory;
      continue;
    }
    switch (flag) {
      case '--registry-dir':
        registryDir = requireValue(flag, argv[++index]);
        break;
      case '--spawn-command':
        spawnCommand = requireValue(flag, argv[++index]);
        break;
      case '--port': {
        const raw = requireValue(flag, argv[++index]);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error(`--port expects a port number, received "${raw}".`);
        }
        port = parsed;
        break;
      }
      case '--host':
        host = requireValue(flag, argv[++index]);
        break;
      case '--assets':
        assetsDir = requireValue(flag, argv[++index]);
        break;
      case '--state-dir':
        stateDir = requireValue(flag, argv[++index]);
        break;
      case '--dir':
        directory = requireValue(flag, argv[++index]);
        break;
      case '--cloudflared':
        cloudflaredPath = requireValue(flag, argv[++index]);
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--version':
      case '-v':
        version = true;
        break;
      default:
        throw new Error(`Unknown option "${flag}".`);
    }
  }

  return {
    registryDir,
    spawnCommand,
    port,
    host,
    assetsDir,
    stateDir,
    directory,
    cloudflaredPath,
    help,
    version,
  };
}

export function serveHelp(): string {
  return `Usage: doompi-web [options]\n\nOptions:\n  --dir <path>          Pin, sync, and watch one repository composition\n  --registry-dir <path> Session registry (default: ~/.doompi/run)\n  --spawn-command <cmd> Command used to launch sessions\n  --port <number>       HTTP port (default: 7433)\n  --host <address>      Bind address (default: 127.0.0.1)\n  --assets <path>       Override the built SPA directory\n  --state-dir <path>    Remote-access and cockpit state directory\n  --cloudflared <path>  cloudflared binary\n  -h, --help            Show this help\n  -v, --version         Show the package version\n`;
}
