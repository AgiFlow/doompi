import path from 'node:path';

import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';

import { DeferredSkillLoader, type DeferredSkillSnapshot } from '../deferredSkills';
export interface ServerSkillInventory {
  readonly inventory: DeferredSkillSnapshot;
  readonly catalog: string;
}
export async function discoverServerSkills(
  execution: DoomHeadlessExecutionContext,
  signal: AbortSignal,
): Promise<ServerSkillInventory> {
  signal.throwIfAborted();
  const state = readHarnessState(execution.environment);
  const inventory = await new DeferredSkillLoader({
    cwd: execution.cwd,
    skillPaths: [...(state.skillDirectories ?? []), path.join(execution.repoRoot, '.doom', 'skills')],
  }).ready();
  signal.throwIfAborted();
  return { inventory, catalog: formatSkillsForPrompt(inventory.skills) || '(no discovered skills)' };
}
