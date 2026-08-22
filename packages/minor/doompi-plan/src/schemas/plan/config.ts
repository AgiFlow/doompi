import {
  getHarnessState,
  globalDoomConfigPath,
  loadHarnessState,
  loadDoomConfig as loadSharedDoomConfig,
  mergeDoomConfigs as mergeSharedDoomConfigs,
  type PlanningAgentConfig,
  type PlanningModeConfig,
  type PlanningThinkingLevel,
  parsePlanningModeConfig,
  parseDoomConfig as parseSharedDoomConfig,
  repositoryDoomConfigPath,
  resolvePlanningPlansDirectory,
} from '@agimon-ai/doompi-config';

export type { PlanningAgentConfig, PlanningModeConfig, PlanningThinkingLevel };

export interface DoomConfig {
  modes?: {
    planning?: PlanningModeConfig;
  };
}

const DEFAULT_PROJECT_TRUST = 'ask' as const;

export {
  getHarnessState,
  globalDoomConfigPath,
  loadHarnessState,
  parsePlanningModeConfig,
  repositoryDoomConfigPath,
  resolvePlanningPlansDirectory,
};

export function parseDoomConfig(content: string, filePath: string): DoomConfig {
  const config = parseSharedDoomConfig(content, filePath);
  return config.modes ? { modes: config.modes } : {};
}

export function mergeDoomConfigs(globalConfig: DoomConfig, repositoryConfig: DoomConfig): DoomConfig {
  const merged = mergeSharedDoomConfigs(
    { ...globalConfig, projectTrust: DEFAULT_PROJECT_TRUST },
    { ...repositoryConfig, projectTrust: DEFAULT_PROJECT_TRUST },
  );
  return merged.modes ? { modes: merged.modes } : {};
}

export function loadDoomConfig(repoRoot: string, homeDirectory?: string): DoomConfig {
  const config = loadSharedDoomConfig(repoRoot, homeDirectory);
  return config.modes ? { modes: config.modes } : {};
}
