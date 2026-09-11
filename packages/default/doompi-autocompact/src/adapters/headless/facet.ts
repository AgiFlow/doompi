import { loadDoomConfig } from '@agimon-ai/doompi-config';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessActivity,
  type DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { Context } from '@deepseek-ai/cordis';

export const autocompactHeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    const resource: DoomHeadlessResource = {
      name: 'doompi/autocompact-config',
      kind: 'context',
      read: (execution) => JSON.stringify(loadDoomConfig(execution.repoRoot).modes?.autocompact ?? {}),
    };
    // The public structural hook can return a completed compaction, but exposes no checkpoint-generation boundary.
    // Re-entering session.compact() from that hook owns the same lane and fails busy, so retain native threshold fallback.
    const activity: DoomHeadlessActivity = {
      name: 'doompi-autocompact',
      start(execution) {
        const enabled = loadDoomConfig(execution.repoRoot).modes?.autocompact?.enabled === true;
        execution.client.setStatus('doom-autocompact', enabled ? 'native fallback' : undefined);
        return () => execution.client.setStatus('doom-autocompact', undefined);
      },
    };
    const registrations = [host.registerResource(resource), host.registerActivity(activity)];
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  },
};
