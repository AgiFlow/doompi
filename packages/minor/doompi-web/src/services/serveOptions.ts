export interface ServeOptions {
  /** Fixed single-session mode; absent means hub mode. */
  socketPath?: string;
  tokenFile?: string;
  /** Hub mode registry override; the default is resolved by the caller. */
  registryDir?: string;
  /** Hub mode: command launching created sessions; defaults to doompi-server. */
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
 * With no mode flags at all the cockpit is a hub over the default registry
 * directory; --socket pins it to one session instead. The token is read from a
 * file rather than an argument so it never lands in the process table where
 * any local user can read it.
 */
export function parseServeOptions(argv: readonly string[]): ServeOptions {
  let socketPath: string | undefined;
  let tokenFile: string | undefined;
  let registryDir: string | undefined;
  let spawnCommand: string | undefined;
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let assetsDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--socket':
        socketPath = requireValue(flag, argv[++index]);
        break;
      case '--auth-token-file':
        tokenFile = requireValue(flag, argv[++index]);
        break;
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

  if (socketPath !== undefined || tokenFile !== undefined) {
    if (!socketPath) throw new Error('--socket is required when --auth-token-file is given.');
    if (!tokenFile) throw new Error('--auth-token-file is required when --socket is given.');
    if (registryDir !== undefined) throw new Error('Pass either --registry-dir or --socket, not both.');
  }
  return { socketPath, tokenFile, registryDir, spawnCommand, port, host, assetsDir };
}
