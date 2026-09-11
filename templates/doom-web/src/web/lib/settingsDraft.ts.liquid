import type { SettingsFieldContribution } from '@agimon-ai/doompi-web-contracts';
import type { SettingsScope, SettingsValueView, SettingsWriteRequest } from '../../types/settings.ts';

/**
 * What a settings page does with pending edits, kept out of the component so it
 * can be checked without a browser.
 *
 * The rules that matter are all here: a field is only editable at a scope the
 * key is actually read from, a cleared field removes the key rather than
 * writing an empty value the parser rejects, and each write carries the hash
 * the one before it produced so a batch cannot half-apply against stale bytes.
 */

const KEY_SEPARATOR = '.';

export function settingsKeyOf(field: SettingsFieldContribution): string {
  return field.keyPath.join(KEY_SEPARATOR);
}

/** Why a field cannot be edited at the selected scope, or nothing. */
export function settingsLockedReason(view: SettingsValueView | undefined, scope: SettingsScope): string | undefined {
  if (view === undefined || view.scope === 'both' || view.scope === scope) return undefined;
  return view.scope === 'global' ? 'global only' : 'repository only';
}

export interface PlannedWritesInput {
  fields: readonly SettingsFieldContribution[];
  /** Pending edits by dotted key; null clears the key. */
  drafts: Readonly<Record<string, string | null>>;
  scope: SettingsScope;
  repoRoot: string;
  /** The target file's hash when the page last read it. */
  startingHash: string;
}

/**
 * The writes a save issues, in order. Only the first carries the hash the page
 * read; the caller threads each answer's hash into the next, which is why this
 * returns a list rather than firing them in parallel.
 */
export function plannedSettingsWrites(input: PlannedWritesInput): SettingsWriteRequest[] {
  return input.fields
    .filter((field) => settingsKeyOf(field) in input.drafts)
    .map((field) => ({
      repoRoot: input.repoRoot,
      scope: input.scope,
      keyPath: field.keyPath,
      value: input.drafts[settingsKeyOf(field)] ?? null,
      expectedHash: input.startingHash,
    }));
}

/** Whether a save can be attempted at all: something changed, and it can land somewhere. */
export function canSaveSettings(input: { dirty: number; scope: SettingsScope; repoRoot: string }): boolean {
  if (input.dirty === 0) return false;
  // A repository write needs a repository; a global one never does.
  return input.scope === 'global' || input.repoRoot !== '';
}
