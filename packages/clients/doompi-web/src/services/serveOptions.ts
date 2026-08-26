export interface ServeOptions {
  /** Registry override; the default is resolved by the caller. */
  registryDir?: string;
  /** Command launching created sessions; the caller resolves one when this is absent. */
  spawnCommand?: string;
  port: number;
  host: string;
  assetsDir?: string;
}

const DEFAULT_PORT = 7433;
const DEFAULT_HOST = '127.0.0.1';

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
  return value;
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

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
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
      default:
        throw new Error(`Unknown option "${flag}".`);
    }
  }

  return { registryDir, spawnCommand, port, host, assetsDir };
}
