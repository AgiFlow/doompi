import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  COCKPIT_HARNESS_EXPORT_SUBPATH,
  isCockpitContainerHarnessModule,
  type CockpitContainerHandle,
  type CockpitContainerHarnessModule,
  type CockpitWorkspace,
} from '@agimon-ai/doompi-extension-contracts/cockpit-container';

/**
 * Owns the container the cockpit hands over to.
 *
 * The harness is resolved from the composition rather than imported, the same
 * way core resolves the interactive sandbox, so this package never depends on a
 * container technology. What lives here is the part the harness cannot own: the
 * container's lifetime relative to *this* process, and the record that lets a
 * later start clean up after a process that did not get to.
 */

const ID_FILE = 'cockpit-container.json';
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
/** How often the supervisor checks the container it is holding open for. */
export const SUPERVISE_POLL_MS = 2000;
/** Past this the recorded id is more likely to name something else than the container. */
const ID_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Layer packages that may host the cockpit, in the order they are tried. */
const HARNESS_PACKAGES = ['@agimon-ai/doompi-sandbox'];

export interface CockpitContainerOptions {
  stateDir: string;
  onNotice?: (message: string) => void;
  /** Test seam: stands in for looking a harness up in the composition. */
  resolveHarness?: () => Promise<CockpitContainerHarnessModule | undefined>;
  now?: () => number;
  /** Test seam: how often the supervisor asks whether the container is still there. */
  supervisePollMs?: number;
}

export interface StartedCockpitContainer {
  containerId: string;
  stop: () => Promise<void>;
  /**
   * Keeps this process alive for as long as the container is, and no longer.
   *
   * A cockpit that has handed over has closed its server, so nothing else holds
   * its event loop open: without this it would exit immediately and leave a
   * container running with nobody to stop it. Resolves when the container is
   * gone, whether that was asked for or not.
   */
  supervise: () => Promise<void>;
}

export type CockpitContainerOutcome = { ok: true; container: StartedCockpitContainer } | { ok: false; error: string };

/**
 * Finds a layer that can host the cockpit.
 *
 * Dynamic on purpose: a composition without a sandbox layer simply cannot
 * offer this, and saying so is better than a build-time dependency that makes
 * every install carry container code it will never run.
 */
async function resolveHarness(onNotice: (message: string) => void): Promise<CockpitContainerHarnessModule | undefined> {
  const require = createRequire(import.meta.url);
  for (const name of HARNESS_PACKAGES) {
    let entry: string;
    try {
      entry = require.resolve(`${name}/${COCKPIT_HARNESS_EXPORT_SUBPATH.replace('./', '')}`);
    } catch {
      continue; // Not installed, or too old to export the subpath.
    }
    const loaded: unknown = await import(entry);
    if (isCockpitContainerHarnessModule(loaded)) return loaded;
    onNotice(`${name} exports a cockpit harness this build does not understand; ignoring it`);
  }
  return undefined;
}

export function createCockpitContainer(options: CockpitContainerOptions) {
  const notice = options.onNotice ?? ((): void => {});
  const now = options.now ?? ((): number => Date.now());
  const idPath = path.join(options.stateDir, ID_FILE);
  const findHarness =
    options.resolveHarness ??
    (async (): Promise<CockpitContainerHarnessModule | undefined> => await resolveHarness(notice));

  const record = (containerId: string): void => {
    try {
      fs.mkdirSync(options.stateDir, { recursive: true, mode: DIRECTORY_MODE });
      fs.writeFileSync(idPath, JSON.stringify({ containerId, startedAt: now() }), { mode: FILE_MODE });
    } catch {
      // The reaper is a safety net, not a requirement; losing it does not stop
      // the container from coming up.
    }
  };

  return {
    /**
     * Stops a container an earlier process left running.
     *
     * A cockpit that was killed rather than closed cannot clean up after
     * itself, and the container it left behind still holds the published port,
     * so the next start would fail to bind for a reason nothing explains.
     */
    async reapStale(): Promise<void> {
      let parsed: { containerId?: unknown; startedAt?: unknown };
      try {
        parsed = JSON.parse(fs.readFileSync(idPath, 'utf8')) as typeof parsed;
      } catch {
        return; // No record is the normal case.
      }
      fs.rmSync(idPath, { force: true });
      const containerId = typeof parsed.containerId === 'string' ? parsed.containerId : undefined;
      const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0;
      if (containerId === undefined || now() - startedAt > ID_FILE_MAX_AGE_MS) return;
      const harness = await findHarness();
      if (harness === undefined) return;
      if (await harness.reapCockpitContainer(containerId)) {
        notice(`stopped a cockpit container left running by a previous process (${containerId})`);
      }
    },

    async start(input: {
      workspaces: readonly CockpitWorkspace[];
      port: number;
      onProgress?: (message: string) => void;
    }): Promise<CockpitContainerOutcome> {
      const harness = await findHarness();
      if (harness === undefined) {
        return {
          ok: false,
          error: 'No installed layer can host the cockpit in a container. Add @agimon-ai/doompi-sandbox.',
        };
      }
      const started = await harness.startCockpitContainer({
        workspaces: input.workspaces,
        port: input.port,
        environment: process.env,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      });
      if (!started.ok) return { ok: false, error: started.error };
      record(started.handle.containerId);
      notice(`cockpit container ${started.handle.containerId} is serving on port ${String(input.port)}`);
      return {
        ok: true,
        container: hold(started.handle, idPath, notice, options.supervisePollMs ?? SUPERVISE_POLL_MS),
      };
    },
  };
}

/**
 * Binds the container's lifetime to this process.
 *
 * The same shape as the tunnel: signals stop it, and a synchronous `exit`
 * handler is the net under `process.exit`, an uncaught exception, and an
 * unhandled rejection, none of which reach a graceful path. A `SIGKILL` still
 * escapes, which is what the id file and `reapStale` are for.
 */
function hold(
  handle: CockpitContainerHandle,
  idPath: string,
  notice: (message: string) => void,
  pollMs: number,
): StartedCockpitContainer {
  let stopped = false;
  const onExit = (): void => {
    // Synchronous: async work in an exit handler never runs. Best effort, and
    // the id file covers what this cannot.
    try {
      fs.rmSync(idPath, { force: true });
    } catch {
      // Nothing further to do at exit.
    }
  };
  process.once('exit', onExit);

  const forget = (): void => {
    process.off('exit', onExit);
    onExit();
  };

  return {
    containerId: handle.containerId,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      forget();
      await handle.stop().catch((error: unknown) => {
        notice(`the cockpit container did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    supervise: async () => {
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (stopped) return;
        if (await handle.alive()) continue;
        // Not a clean stop: the container went away on its own, so the record
        // is cleared and the caller is told rather than left waiting.
        stopped = true;
        forget();
        notice(`the cockpit container ${handle.containerId} stopped on its own`);
        return;
      }
    },
  };
}
