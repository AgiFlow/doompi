import { disposeHarnessState } from '@agimon-ai/doompi-config/harnessStore';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// Imported from the module rather than the barrel: Pi loads this file directly
// and it is the first thing a synced session runs, so it pulls in nothing it
// does not use.
import {
  type ComposeOutcome,
  cleanupRunDirectory,
  composeDoomSession,
  findSyncedRoot,
  registerDoomFlags,
} from '../../adapters/composer.ts';
import { acquireCompositionClaim } from '../../adapters/compositionState.ts';
const WARNING = 'warning';
const STALE_MESSAGE = 'doompi config changed since the last sync. Run doompi sync.';

/**
 * The one entry `doom-pi sync` puts in Pi's own config.
 *
 * Everything doom-pi contributes to a plain `pi` session is loaded from here,
 * which is what keeps `.pi/settings.json` to a single stable line and lets the
 * whole matrix be recomposed on `/reload` rather than frozen at startup.
 */
export async function doomExtension(pi: ExtensionAPI): Promise<void> {
  const releaseClaim = acquireCompositionClaim();
  if (!releaseClaim) return;

  try {
    registerDoomFlags(pi);
    const outcome: ComposeOutcome = await composeDoomSession(pi);

    // Reported on session_start rather than thrown: composition problems have to
    // reach the user through the UI, and the UI does not exist yet at load time.
    pi.on('session_start', (_event, ctx) => {
      // Every configured factory has loaded. A later /reload gets a new claim,
      // while a duplicate registration in this runner has already stood down.
      releaseClaim();
      for (const problem of outcome.problems) ctx.ui.notify(problem, WARNING);
      if (outcome.stale) ctx.ui.notify(STALE_MESSAGE, WARNING);
    });

    pi.on('session_shutdown', async (_event, ctx) => {
      const repoRoot = findSyncedRoot(ctx.cwd);
      if (!repoRoot) return;
      // The state file first, so nothing is left pointing at a path that is
      // about to disappear, then the directory it lived in.
      disposeHarnessState();
      await cleanupRunDirectory(repoRoot);
    });
  } catch (error) {
    // Pi discards a failed factory, including the session_start handler that
    // would normally release ownership. Leave a retry or reload possible.
    releaseClaim();
    throw error;
  }
}

export default doomExtension;
