import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The hub refuses a socket path longer than this; see doompi-web serverSpawner. */
const SOCKET_BUDGET = 103;
/**
 * What the hub still has to append after the registry directory: a `spawned`
 * segment, a session id prefix, the socket filename, and the `.pi` suffix that
 * the protocol socket adds on top of the longest of those.
 */
const RESERVED_FOR_SESSION = 40;

export const DEFAULT_PORT = 7433;
export const LOOPBACK_HOST = '127.0.0.1';

/** Locates the bundled cockpit entry in the desktop runtime artifact. */
export function hubEntry(input: { resourcesPath: string; packaged: boolean; projectRoot: string }): string {
  const runtimeRoot = input.packaged
    ? path.join(input.resourcesPath, 'runtime')
    : path.join(input.projectRoot, 'build', 'runtime');
  return path.join(runtimeRoot, 'doompi-web', 'dist', 'bin', 'serve.mjs');
}

/**
 * Runs every desktop child on Electron's Node runtime and points dynamic launch
 * seams at files in the bundled artifact rather than an installed node_modules.
 */
export function hubEnvironment(base: NodeJS.ProcessEnv, entry: string): NodeJS.ProcessEnv {
  const runtimeRoot = path.resolve(path.dirname(entry), '..', '..', '..');
  const artifact = (...segments: string[]): string => path.join(runtimeRoot, ...segments);
  return {
    ...base,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_PATH: artifact('native', 'node_modules'),
    DOOMPI_SERVER_COMMAND: artifact('doompi-server', 'dist', 'bin', 'serve.mjs'),
    DOOMPI_AGENT_COMMAND: artifact('doompi', 'dist', 'bin', 'cli.mjs'),
    DOOMPI_PACKAGE_ROOT: artifact('doompi', 'dist', 'src'),
    DOOMPI_WEB_MODULE: pathToFileURL(artifact('doompi-web', 'dist', 'index.mjs')).href,
    DOOMPI_WEB_PACKAGE_ROOT: artifact('doompi-web'),
    DOOMPI_VITE_PACKAGE_ROOT: artifact('vendor', 'vite'),
    DOOMPI_RMUX_BINARY: artifact('native', 'rmux', 'bin', 'rmux'),
    DOOMPI_RTK_BINARY: artifact('native', 'rtk', 'bin', 'rtk'),
  };
}

/**
 * Rejects a registry directory that cannot hold a session socket.
 *
 * macOS caps `sun_path` at 104 bytes, and the failure it produces when a path
 * is too long arrives much later, from the session the user just tried to
 * start. Refusing at startup names the real cause once instead.
 */
export function assertSocketHeadroom(registryDir: string): void {
  const available = SOCKET_BUDGET - registryDir.length;
  if (available >= RESERVED_FOR_SESSION) return;
  throw new Error(
    `The session directory ${registryDir} leaves ${String(available)} bytes for a socket name, ` +
      `below the ${String(RESERVED_FOR_SESSION)} a session needs. Use a shorter home directory or set DOOMPI_RUNTIME_DIR.`,
  );
}

/** The argv the cockpit expects for a desktop-owned hub. */
export function hubArguments(plan: HubArgumentInput): string[] {
  return [plan.entry, '--host', plan.host, '--port', String(plan.port), '--registry-dir', plan.registryDir];
}

interface HubArgumentInput {
  entry: string;
  host: string;
  port: number;
  registryDir: string;
}
