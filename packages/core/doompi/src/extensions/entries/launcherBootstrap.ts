import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { updateHarnessState } from '../../adapters/config/harnessState.ts';
import { loadComposedExtensions } from '../../adapters/composer.ts';
import { readLauncherComposition, resolveLauncherLoadPlan } from '../../adapters/launcherComposition.ts';

const WARNING = 'warning';

/**
 * The one Pi entry a composing launcher session registers.
 *
 * Pi captures its CLI extension list once per process, so handing it the
 * fingerprint-named aggregate freezes the composition for the process. This
 * entry is a stable path instead: the list never changes, and every load,
 * including a reload, resolves the composition that is selected at that
 * moment and activates it. All work happens inside the factory rather than at
 * module scope, because Pi caches the module and only calls the export again.
 */
export async function launcherBootstrap(pi: ExtensionAPI): Promise<void> {
  const state = readLauncherComposition();
  if (!state) return;

  const problems: string[] = [];
  const plan = resolveLauncherLoadPlan(state);
  // Doom Team reads the child activation and the identity from the environment
  // the store publishes, so both have to be refreshed before anything spawns.
  updateHarnessState({ childExtensions: plan.childExtensions, compositionFingerprint: plan.fingerprint });
  await loadComposedExtensions(pi, plan.entries, problems);

  if (problems.length > 0) {
    pi.on('session_start', (_event, ctx) => {
      for (const problem of problems) ctx.ui.notify(problem, WARNING);
    });
  }
}

export default launcherBootstrap;
