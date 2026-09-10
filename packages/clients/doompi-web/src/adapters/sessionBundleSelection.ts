import fs from 'node:fs';
import path from 'node:path';
import type { SyncRegistration } from '@agimon-ai/doompi/services';
import type { SessionRecord } from '../types/registry.ts';

/** Admit the owning session's pinned selection, never the repository's newer default. */
export function sessionBundleSelection(
  record: Pick<SessionRecord, 'serverComposition'>,
  registration: Pick<SyncRegistration, 'root' | 'generationRoot'>,
): NonNullable<SessionRecord['serverComposition']> | undefined {
  const composition = record.serverComposition;
  if (composition === undefined) return undefined;
  const root = fs.realpathSync(registration.root);
  if (fs.realpathSync(composition.root) !== root)
    throw new Error('Session server composition belongs to another repository');
  if (path.basename(composition.generation) !== composition.generation) throw new Error('Invalid session generation');
  const directory = fs.realpathSync(composition.apiDirectory);
  const generations = fs.realpathSync(path.dirname(registration.generationRoot));
  const expected = path.join(generations, composition.generation, 'api');
  if (directory !== expected) throw new Error('Session server composition escapes its admitted generation');
  return { ...composition, root, apiDirectory: directory, activeLayers: [...composition.activeLayers] };
}

export function sessionBundleKey(composition: NonNullable<SessionRecord['serverComposition']>): string {
  return JSON.stringify([
    composition.root,
    composition.apiDirectory,
    composition.generation,
    composition.fingerprint,
    composition.majorMode,
    [...new Set(composition.activeLayers)].sort(),
  ]);
}
