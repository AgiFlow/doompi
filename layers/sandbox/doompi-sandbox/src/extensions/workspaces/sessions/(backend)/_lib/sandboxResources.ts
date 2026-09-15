import type { DoomHeadlessResource } from '@agimon-ai/doompi-core/headless';

import { readPackageResource } from '../../../../../services/packageResource';
import type { SandboxServerScope } from './sandboxScope';

export function createSandboxContextResource(root: SandboxServerScope): DoomHeadlessResource | undefined {
  if (!root.service) return undefined;
  return { name: 'doompi-sandbox', kind: 'context', read: () => readPackageResource('llms.txt') };
}

export function createSandboxSkillResource(root: SandboxServerScope): DoomHeadlessResource | undefined {
  if (!root.service) return undefined;
  return {
    name: 'doompi-use-sandbox',
    kind: 'skill',
    read: () => readPackageResource('src/prompts/doompi-use-sandbox/SKILL.md'),
  };
}

export function createSandboxReadmeResource(root: SandboxServerScope): DoomHeadlessResource | undefined {
  if (!root.service) return undefined;
  return { name: 'doompi-sandbox-readme', kind: 'context', read: () => readPackageResource('README.md') };
}

export function createSandboxHelpResource(moduleUrl: string) {
  return {
    source: '@agimon-ai/doompi-sandbox',
    moduleUrl,
    skills: [
      {
        name: 'doompi-use-sandbox',
        description:
          'Use @agimon-ai/doompi-sandbox: Container sandbox for DoomPi launches: the agent, extensions, and tools run inside Docker or Podman while the terminal stays on the host',
      },
    ],
  };
}
