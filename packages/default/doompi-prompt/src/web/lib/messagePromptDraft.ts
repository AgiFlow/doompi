import { defineGlobalStore, type UserMessageActionRunContext } from '@agimon-ai/doompi-core/web';
import type { DraftState } from './promptsActions';

/**
 * Package-local handoff from anything that asks for the prompt library to the
 * component that owns it.
 *
 * DESIGN PATTERNS:
 * - Neither caller has a React owner: a timeline action runs from the host's
 *   menu, and a composer menu entry unmounts the moment the menu closes. Both
 *   publish one short-lived request instead of holding dialog state.
 * - One request pipe, not two. A request carrying a draft opens the editor on
 *   that text; a request carrying nothing opens the picker. The dialog owner
 *   subscribes once and handles both.
 *
 * AVOID:
 * - Persisting drafts or message content in browser storage.
 * - Making the host understand prompt-specific dialog state.
 * - Signalling "no draft" with an empty draft: an empty draft is a real state
 *   the editor can be in, so it cannot also mean the absence of one.
 */

/** One ask for the prompt library. A absent draft opens the picker rather than the editor. */
export interface PromptDialogRequest {
  draft?: DraftState;
}

type PromptDialogListener = (request: PromptDialogRequest) => void;

const promptDialogRequest = defineGlobalStore<PromptDialogRequest | undefined>(undefined);

export function requestMessagePromptDraft(context: UserMessageActionRunContext): void {
  const draft: DraftState = { name: '', text: context.text, original: '' };
  promptDialogRequest.update(() => ({ draft }));
}

/** Opens the library with nothing prefilled, as the composer menu entry does. */
export function requestPromptDialogOpen(): void {
  promptDialogRequest.update(() => ({}));
}

export function subscribePromptDialogRequest(listener: PromptDialogListener): () => void {
  const deliver = (): void => {
    const request = promptDialogRequest.store.state;
    if (!request) return;
    promptDialogRequest.reset();
    listener(request);
  };
  const subscription = promptDialogRequest.store.subscribe(deliver);
  deliver();
  return () => subscription.unsubscribe();
}
