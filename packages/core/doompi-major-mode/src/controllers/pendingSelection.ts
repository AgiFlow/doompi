import {
  replaceDoomConfigContext,
  requireDoomConfigContext,
  supersedeDoomConfigTransition,
} from '@agimon-ai/doompi-config/piContext';
import type { DoomConfigContext, DoomConfigPendingSelection } from '@agimon-ai/doompi-config/types';
import type { TransitionSelectionSnapshot } from '@agimon-ai/doompi-extension-contracts/transition';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** The journal shape a transition records for the session that resumes after it. */
export function selectionFromSnapshot(snapshot: TransitionSelectionSnapshot) {
  return {
    version: 1 as const,
    majorMode: snapshot.majorMode,
    domains: [...snapshot.domains],
    profile: snapshot.profile,
    compositionFingerprint: snapshot.compositionFingerprint,
  };
}

export function clearPendingSelection(pi: ExtensionAPI, cordis: Context): void {
  const context = requireDoomConfigContext(cordis);
  const pendingSelection = context.pendingSelection;
  if (!pendingSelection) return;
  supersedeDoomConfigTransition(pi, pendingSelection);
  replaceDoomConfigContext(cordis, Object.freeze({ ...context, pendingSelection: undefined }));
}

export function bindPendingSelection(
  context: DoomConfigContext,
  pendingSelection: DoomConfigPendingSelection,
): DoomConfigContext {
  const freezeSelection = (selection: DoomConfigPendingSelection['active']) =>
    Object.freeze({ ...selection, domains: Object.freeze([...selection.domains]) });
  return Object.freeze({
    ...context,
    pendingSelection: Object.freeze({
      ...pendingSelection,
      active: freezeSelection(pendingSelection.active),
      target: freezeSelection(pendingSelection.target),
    }),
  });
}
