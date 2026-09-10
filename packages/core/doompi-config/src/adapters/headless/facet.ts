import { readFile } from 'node:fs/promises';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';

const PACKAGE_ROOT = new URL('../../../', import.meta.url);

function selectionMetadata(execution: {
  readonly selection: {
    readonly profile?: string;
    readonly domains: readonly string[];
    readonly majorMode: string;
    readonly activeLayers: readonly string[];
  };
}): string {
  return JSON.stringify({
    profile: execution.selection.profile ?? null,
    domains: execution.selection.domains,
    majorMode: execution.selection.majorMode,
    activeLayers: execution.selection.activeLayers,
  });
}

async function readPackageResource(name: string): Promise<string> {
  try {
    return await readFile(new URL(name, PACKAGE_ROOT), 'utf8');
  } catch {
    return `(resource unavailable: ${name})`;
  }
}

export const configHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const configResource: DoomHeadlessResource = {
      name: 'doompi/config',
      kind: 'context',
      read: (execution) => selectionMetadata(execution),
    };
    const skillResource: DoomHeadlessResource = {
      name: 'doompi-author-config',
      kind: 'skill',
      read: () => readPackageResource('src/prompts/doompi-author-config/SKILL.md'),
    };
    const registrations = [host.registerResource(configResource), host.registerResource(skillResource)];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
