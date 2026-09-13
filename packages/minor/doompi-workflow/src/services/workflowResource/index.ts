import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
function packageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Workflow package resources are unavailable.');
    directory = parent;
  }
  return directory;
}
export function workflowSkillDirectory(): string {
  return path.join(packageRoot(), 'skills');
}
export async function readWorkflowSkill(name: string): Promise<string> {
  return readFile(
    path.join(packageRoot(), name === 'workflow-recovery' ? 'skills' : 'src/prompts', name, 'SKILL.md'),
    'utf8',
  );
}
