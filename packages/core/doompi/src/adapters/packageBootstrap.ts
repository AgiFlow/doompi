import { pathToFileURL } from 'node:url';
import { DOOMPI_EXTENSIONS_PROVIDED_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { acquireBootstrapClaim } from './bootstrapClaim.ts';
import { findSyncedRoot, readStartupBootstrapStatus } from './bootstrapLocator.ts';

type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

const SESSION_START = 'session_start';
const WARNING = 'warning';
const ENABLED_FLAG = '1';
const UNUSABLE_STATE_MESSAGE = 'doompi could not read its synchronized state. Run doompi sync.';

async function currentBootstrap(repoRoot: string): Promise<string> {
  const status = readStartupBootstrapStatus(repoRoot);
  if (status.fresh && status.bootstrap) return status.bootstrap;
  throw new Error('DoomPi synchronized bootstrap is missing or stale. Run doompi sync.');
}

/**
 * Reports a state this install cannot honour without failing Pi's startup.
 *
 * A state file written by a different DoomPi version, or by a different
 * repository, is a synchronization problem the user fixes with one command.
 * Throwing here would only turn it into an extension load failure, so the
 * detail is carried to the UI instead, which does not exist yet at load time.
 */
function reportUnusableState(pi: ExtensionAPI): void {
  pi.on(SESSION_START, (_event, ctx) => {
    ctx.ui.notify(UNUSABLE_STATE_MESSAGE, WARNING);
  });
}

/** Stable user-package entry that delegates to a fresh synchronized bootstrap. */
export async function packageBootstrap(pi: ExtensionAPI): Promise<void> {
  // A launcher-provided aggregate already contains the complete composed set.
  // Stand down before touching synchronized state so launch does not pay for a
  // bootstrap it will never import.
  if (process.env[DOOMPI_EXTENSIONS_PROVIDED_ENV] === ENABLED_FLAG) return;

  const repoRoot = findSyncedRoot(process.cwd());
  // DoomPi is registered in user settings, so it is also discovered outside a
  // synchronized repository. Staying inert avoids loading the runtime globally.
  if (!repoRoot) return;

  // Claimed before the first await, so a sibling install registered from the
  // other settings scope cannot interleave. It reads nothing, compiles nothing,
  // and writes nothing: one install owns this repository's load cycle.
  const releaseClaim = acquireBootstrapClaim(repoRoot);
  if (!releaseClaim) return;

  let bootstrap: string;
  try {
    bootstrap = await currentBootstrap(repoRoot);
  } catch {
    releaseClaim();
    reportUnusableState(pi);
    return;
  }

  try {
    const module = (await import(pathToFileURL(bootstrap).href)) as { default?: unknown };
    if (typeof module.default !== 'function') {
      throw new Error(`DoomPi bootstrap does not export an extension factory: ${bootstrap}`);
    }
    await (module.default as ExtensionFactory)(pi);
    // Released once Pi has started the runner this load produced, so a later
    // /reload composes again instead of finding the cycle still owned.
    pi.on(SESSION_START, () => {
      releaseClaim();
    });
  } catch (error) {
    releaseClaim();
    throw error;
  }
}

export default packageBootstrap;
