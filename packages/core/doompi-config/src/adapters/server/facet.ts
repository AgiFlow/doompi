import { readDoomHeadlessHost, type DoomHeadlessResource } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { readFile } from 'node:fs/promises';

import { settingsApi } from './settingsApi.ts';

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

export const configServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const server = requireDoomServerHost(context);
    if (server.scope !== 'session') {
      const registration = server.registerApi(settingsApi);
      return () => registration.dispose();
    }
    const host = readDoomHeadlessHost(context);
    if (!host) return undefined;
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
