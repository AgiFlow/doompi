import { useStore } from '@tanstack/react-store';
import { useMemo } from 'react';
import { type ToolPromptClaim, toolPromptClaim } from '../lib/toolPrompt.ts';
import { menuStore } from './menuStore.ts';
import { useActiveSession } from './sessionStore.ts';
import { toolPromptStore } from './toolPromptStore.ts';

/**
 * The running tool standing in for the composer, or null while none is.
 *
 * The composer and the host's dialog both read this, so the request has
 * exactly one owner on any given frame. The three facts are selected apart and
 * the verdict memoized on them: a claim is a fresh object each time it is
 * computed, and selecting it directly would make every unrelated frame look
 * like a change.
 */
export function useToolPrompt(): ToolPromptClaim | null {
  const dialog = useActiveSession((state) => state.dialog);
  const entries = useActiveSession((state) => state.entries);
  const statuses = useActiveSession((state) => state.statuses);
  const claimedMenu = useStore(menuStore, (state) => state.claimed?.dialogId ?? null);
  const failed = useStore(toolPromptStore, (state) => state.failedDialogId);
  // Both ids can be stale, so neither speaks for the open request unless it
  // names it: a claim left over from an earlier turn must not wave this one through.
  const open = dialog?.id ?? null;
  const spokenFor = open !== null && (open === claimedMenu || open === failed) ? open : null;
  return useMemo(
    () => toolPromptClaim({ dialog, entries, statuses }, spokenFor),
    [dialog, entries, statuses, spokenFor],
  );
}
