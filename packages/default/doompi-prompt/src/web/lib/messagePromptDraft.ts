import { defineGlobalStore, type UserMessageActionRunContext } from '@agimon-ai/doompi-web-contracts';
import type { DraftState } from './promptsActions.ts';

/**
 * Package-local handoff from a timeline action to the mounted prompt dialog.
 *
 * DESIGN PATTERNS:
 * - The web plugin action has no React owner, so it publishes one short-lived
 *   request to the activity section that already owns prompt dialog state.
 * - Message text is copied into a new editable draft; the user must choose a
 *   stable name before anything is written.
 *
 * AVOID:
 * - Persisting drafts or message content in browser storage.
 * - Making the host understand prompt-specific dialog state.
 */

type MessagePromptListener = (draft: DraftState) => void;

const messagePromptDraft = defineGlobalStore<DraftState | undefined>(undefined);

export function requestMessagePromptDraft(context: UserMessageActionRunContext): void {
  const draft: DraftState = { name: '', text: context.text, original: '' };
  messagePromptDraft.update(() => draft);
}

export function subscribeMessagePromptDraft(listener: MessagePromptListener): () => void {
  const deliver = (): void => {
    const draft = messagePromptDraft.store.state;
    if (!draft) return;
    messagePromptDraft.reset();
    listener(draft);
  };
  const subscription = messagePromptDraft.store.subscribe(deliver);
  deliver();
  return () => subscription.unsubscribe();
}
