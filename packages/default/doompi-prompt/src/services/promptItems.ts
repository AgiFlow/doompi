import type { SelectItem } from '@earendil-works/pi-tui';
import type { SavedPrompt } from '../types/prompt.ts';
import { describePrompt } from './savedPromptDocument.ts';

/**
 * Picker rows for staged and saved prompts.
 *
 * DESIGN PATTERNS:
 * - Values are opaque routing keys, never the prompt text: a value carries the
 *   section and the index or name, and the caller resolves it back to text.
 *   Prompt bodies are multi-line, and a list value has to stay one token.
 * - Section headings are plain disabled-looking rows rather than a new picker
 *   feature, so the shared MatrixPicker stays untouched.
 *
 * AVOID:
 * - Putting the prompt body in the label: the list renders one line per row.
 */

const RECENT_VALUE_PREFIX = 'recent:';
const SAVED_VALUE_PREFIX = 'saved:';

export interface PromptSelection {
  kind: 'recent' | 'saved';
  key: string;
}

export function promptItems(recent: readonly string[], saved: readonly SavedPrompt[]): SelectItem[] {
  const items: SelectItem[] = [];
  for (const [index, text] of recent.entries()) {
    items.push({
      value: `${RECENT_VALUE_PREFIX}${String(index)}`,
      label: describePrompt(text) || text,
      description: 'staged this session',
    });
  }
  for (const prompt of saved) {
    items.push({
      value: `${SAVED_VALUE_PREFIX}${prompt.name}`,
      label: `/${prompt.name}`,
      description: prompt.description || describePrompt(prompt.text),
    });
  }
  return items;
}

/** Reads a picker value back into the entry it points at. */
export function parsePromptSelection(value: string): PromptSelection | undefined {
  if (value.startsWith(RECENT_VALUE_PREFIX)) {
    return { kind: 'recent', key: value.slice(RECENT_VALUE_PREFIX.length) };
  }
  if (value.startsWith(SAVED_VALUE_PREFIX)) {
    return { kind: 'saved', key: value.slice(SAVED_VALUE_PREFIX.length) };
  }
  return undefined;
}

/** The text a selected row stages, or undefined when the row went stale. */
export function resolvePromptSelection(
  value: string,
  recent: readonly string[],
  saved: readonly SavedPrompt[],
): string | undefined {
  const selection = parsePromptSelection(value);
  if (!selection) return undefined;
  if (selection.kind === 'recent') {
    const index = Number.parseInt(selection.key, 10);
    return Number.isInteger(index) ? recent[index] : undefined;
  }
  return saved.find((prompt) => prompt.name === selection.key)?.text;
}

/** Appends to a draft instead of discarding it, since staging is additive. */
export function stagedEditorText(draft: string, chosen: string): string {
  return draft.trim() ? `${draft.replace(/\s+$/u, '')}\n${chosen}` : chosen;
}
