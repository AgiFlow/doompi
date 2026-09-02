import path from 'node:path';

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

/**
 * Locates the cockpit payload staged next to the packaged app.
 *
 * The payload ships as `extraResources` rather than inside the asar because a
 * packaged Vite composition has to exec real binaries, and an executable cannot
 * be run from inside an archive.
 *
 * `pnpm deploy` writes the deployed package at the root of its target, with its
 * dependencies under `node_modules` beside it, so the entry sits directly at
 * `hub/dist`, not under `hub/node_modules/@agimon-ai/doompi-web`.
 */
export function hubEntry(input: { resourcesPath: string; packaged: boolean; projectRoot: string }): string {
  const root = input.packaged
    ? path.join(input.resourcesPath, 'app.asar.unpacked', 'build')
    : path.join(input.projectRoot, 'build');
  return path.join(root, 'hub', 'dist', 'bin', 'serve.mjs');
}

/**
 * Runs the staged hub on this app's own binary.
 *
 * Electron is Node when asked to be, so the cockpit, the session server it
 * spawns, and the agent below that all inherit one runtime from this single
 * variable. Nothing downstream has to know it is running inside a desktop app.
 */
export function hubEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, ELECTRON_RUN_AS_NODE: '1' };
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
