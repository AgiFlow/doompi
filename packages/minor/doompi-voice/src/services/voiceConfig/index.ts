import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  globalDoomConfigPath,
  mergeDoomConfigs,
  parseDoomConfig,
  repositoryDoomConfigPath,
} from '@agimon-ai/doompi-config/config';
import { type DoomConfig, type IDoomConfigLoader } from '@agimon-ai/doompi-config/types';

function readVoiceConfig(filePath: string): DoomConfig {
  if (!fs.existsSync(filePath)) return { projectTrust: 'ask' };
  return parseDoomConfig(fs.readFileSync(filePath, 'utf8'), filePath);
}

function checkoutRoot(start: string): string {
  let directory = path.resolve(start);
  while (true) {
    if (
      fs.existsSync(path.join(directory, '.git')) ||
      fs.existsSync(path.join(directory, '.doom')) ||
      fs.existsSync(path.join(directory, '.pi', 'settings.json'))
    )
      return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return path.resolve(start);
    directory = parent;
  }
}

function voiceAgentConfigPath(homeDirectory: string): string {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(homeDirectory, '.pi', 'agent');
  return path.join(agentDirectory, 'doom-voice', 'config.yaml');
}

function readGlobalVoiceConfig(homeDirectory: string): DoomConfig {
  const doomConfig = readVoiceConfig(globalDoomConfigPath(homeDirectory));
  if (doomConfig.voice) return doomConfig;
  const packageConfig = readVoiceConfig(voiceAgentConfigPath(homeDirectory));
  return packageConfig.voice ? mergeDoomConfigs(doomConfig, packageConfig) : doomConfig;
}

export class PiVoiceConfigService implements IDoomConfigLoader {
  load(repoRoot: string, homeDirectory = os.homedir()): DoomConfig {
    const globalConfig = readGlobalVoiceConfig(homeDirectory);
    const trusted = process.env.PI_PROJECT_TRUST === 'trusted';
    if (!trusted) return globalConfig;

    const projectPath = repositoryDoomConfigPath(checkoutRoot(repoRoot));
    const projectConfig = readVoiceConfig(projectPath);
    if (projectConfig.projectTrust === 'never') return globalConfig;
    return mergeDoomConfigs(globalConfig, projectConfig);
  }
}
