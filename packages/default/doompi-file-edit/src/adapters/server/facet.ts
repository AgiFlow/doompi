/**
 * doompi-file-edit's server facet.
 *
 * DESIGN PATTERNS:
 * - Object plugin. The host observes registration before the facet settles.
 * - Thin host adapter. The existing file-edits API owns all request behavior.
 * - Scope-aware. File history belongs to the session that changed the files.
 *
 * AVOID:
 * - Starting work or retaining state in the facet lifecycle.
 */

import { readDoomHeadlessHost, type DoomHeadlessHostService } from '@agimon-ai/doompi-extension-contracts/headless';
import {
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerFacet,
  type DoomServerHostService,
  requireDoomServerHost,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { createFileEditHeadlessContributions } from '../headless.ts';
import { api } from '../fileEditsApi.ts';
import type { FileEditDependencies } from '../../types/index.ts';

export type FileEditContainerFactory = () => FileEditDependencies;

function applyFileEditsServerFacet(
  host: DoomServerHostService,
  headless: DoomHeadlessHostService | undefined,
  createContainer: FileEditContainerFactory | undefined,
): (() => void) | undefined {
  const registrations = [] as Array<{ dispose(): void }>;
  if (host.scope === 'session') registrations.push(host.registerApi(api));

  if (headless && createContainer) {
    const contributions = createFileEditHeadlessContributions(createContainer());
    registrations.push(headless.registerActivity(contributions.activity));
    for (const hook of contributions.hooks) registrations.push(headless.registerHook(hook));
    registrations.push(headless.registerCommand(contributions.command));
  }

  if (registrations.length === 0) return undefined;
  return () => {
    for (const registration of registrations.reverse()) registration.dispose();
  };
}

export const fileEditsServerFacet: DoomServerFacet = {
  inject: [DOOM_SERVER_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomServerHost(context);
    return applyFileEditsServerFacet(host, undefined, undefined);
  },
};

export function createFileEditsServerFacet(createContainer: FileEditContainerFactory): DoomServerFacet {
  return {
    inject: [DOOM_SERVER_HOST_SERVICE],
    apply(context: Context) {
      const host = requireDoomServerHost(context);
      return applyFileEditsServerFacet(host, readDoomHeadlessHost(context), createContainer);
    },
  };
}
