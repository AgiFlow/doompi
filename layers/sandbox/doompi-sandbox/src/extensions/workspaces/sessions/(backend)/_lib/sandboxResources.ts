import type { DoomHeadlessResource } from '@agimon-ai/doompi-core/headless';
import { readPackageResource } from '@agimon-ai/doompi-core/server-facet';

import type { SandboxServerScope } from './sandboxScope';

export function createSandboxContextResource(root: SandboxServerScope): DoomHeadlessResource | undefined {
  if (!root.service) return undefined;
  return {
    // The package index is Help-catalog material, not standing instruction. The Pi
    // facet has always routed it through the Help service; this is the server's gate.
    when: { state: { 'minor-mode': 'help' }, attribution: { kind: 'minor', mode: 'help' } },
    name: 'doompi-sandbox',
    kind: 'context',
    read: () => readPackageResource(import.meta.url, 'llms.txt'),
  };
}

export function createSandboxSkillResource(root: SandboxServerScope): DoomHeadlessResource | undefined {
  if (!root.service) return undefined;
  return {
    name: 'doompi-use-sandbox',
    kind: 'skill',
    read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-sandbox/SKILL.md'),
  };
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
