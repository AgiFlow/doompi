import { loadDoomConfig as loadSharedDoomConfig } from '@agimon-ai/doompi-config/config';
import type { DoomSelectionConfig, ProjectTrust } from '@agimon-ai/doompi-config/types';

const APPROVE_OPTION = '--approve';
const APPROVE_SHORT_OPTION = '-a';
const NO_APPROVE_OPTION = '--no-approve';
const NO_APPROVE_SHORT_OPTION = '-na';
const PROJECT_TRUST_ALWAYS: ProjectTrust = 'always';
const PROJECT_TRUST_NEVER: ProjectTrust = 'never';

export type { ProjectTrust };

export interface DoomConfig {
  projectTrust: ProjectTrust;
  /** The matrix the repository declares by default, read by `doom-pi sync`. */
  selection?: DoomSelectionConfig;
}

export function loadDoomConfig(repoRoot: string): DoomConfig {
  const config = loadSharedDoomConfig(repoRoot);
  return { projectTrust: config.projectTrust, selection: config.selection };
}

export function hasProjectTrustOption(piArgs: string[]): boolean {
  return piArgs.some((argument) =>
    [APPROVE_OPTION, APPROVE_SHORT_OPTION, NO_APPROVE_OPTION, NO_APPROVE_SHORT_OPTION].includes(argument),
  );
}

export function applyProjectTrust(piArgs: string[], config: DoomConfig): string[] {
  if (hasProjectTrustOption(piArgs)) {
    return [...piArgs];
  }
  if (config.projectTrust === PROJECT_TRUST_ALWAYS) return [APPROVE_OPTION, ...piArgs];
  if (config.projectTrust === PROJECT_TRUST_NEVER) return [NO_APPROVE_OPTION, ...piArgs];
  return [...piArgs];
}
