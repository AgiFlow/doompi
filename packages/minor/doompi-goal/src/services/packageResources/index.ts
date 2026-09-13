import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve resources from both source and compiled package modules. */
export async function readPackageResource(name: string, moduleUrl: string | URL = import.meta.url): Promise<string> {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (existsSync(path.join(directory, 'src/prompts/doompi-use-goal/SKILL.md'))) {
      return readFile(path.join(directory, name), 'utf8');
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Goal package resources are unavailable.');
    directory = parent;
  }
}

export function readGoalSkill(): Promise<string> {
  return readPackageResource('src/prompts/doompi-use-goal/SKILL.md');
}
