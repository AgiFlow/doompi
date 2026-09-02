import type { SavedPromptView } from '../types/webPrompts.ts';

/**
 * What the panel does to the library, independent of how it is drawn.
 *
 * DESIGN PATTERNS:
 * - The API is a parameter, so the ordering rules here are testable without a
 *   transport, and the panel keeps only state and markup.
 * - A rename is a write followed by a delete of the old template, never the
 *   other way round: a failed write must not lose the original.
 *
 * AVOID:
 * - Reporting success when the cleanup delete failed. The library would then
 *   hold two copies and the page would show a state nobody chose.
 */

export interface DraftState {
  name: string;
  text: string;
  /** The name being replaced, or '' while creating. */
  original: string;
}

export interface PromptsMutationApi {
  save(name: string, text: string): Promise<{ error: string } | undefined>;
  remove(name: string): Promise<{ error: string } | undefined>;
}

/** The frame the cockpit sends to submit a message to a session. */
export function promptFrame(text: string): Record<string, unknown> {
  return { type: 'prompt', message: text };
}

/** Substring matching over the two columns a row shows. */
export function filterPrompts(prompts: readonly SavedPromptView[], filter: string): readonly SavedPromptView[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return prompts;
  return prompts.filter(
    (prompt) => prompt.name.toLowerCase().includes(needle) || prompt.description.toLowerCase().includes(needle),
  );
}

export const EMPTY_DRAFT: DraftState = { name: '', text: '', original: '' };

export function draftOf(prompt: SavedPromptView): DraftState {
  return { name: prompt.name, text: prompt.text, original: prompt.name };
}

/** Whether the draft is complete enough to send. */
export function canSaveDraft(draft: DraftState): boolean {
  return draft.name.trim().length > 0 && draft.text.trim().length > 0;
}

/** The template a rename leaves behind, or undefined when nothing was renamed. */
export function renamedFrom(draft: DraftState): string | undefined {
  const name = draft.name.trim();
  return draft.original !== '' && draft.original !== name ? draft.original : undefined;
}

/** Writes the draft, then clears the template a rename orphaned. */
export async function commitDraft(draft: DraftState, api: PromptsMutationApi): Promise<{ error: string } | undefined> {
  const name = draft.name.trim();
  const failure = await api.save(name, draft.text);
  if (failure) return failure;

  const orphan = renamedFrom(draft);
  if (orphan === undefined) return undefined;

  const cleanup = await api.remove(orphan);
  if (cleanup) return { error: `Saved /${name}, but /${orphan} could not be removed: ${cleanup.error}` };
  return undefined;
}
