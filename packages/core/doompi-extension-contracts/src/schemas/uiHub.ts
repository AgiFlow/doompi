import type { Context } from '@deepseek-ai/cordis';
import type { DoomConfigContributionHandle, DoomConfigContributionOptions, DoomExtensionContext } from './config.ts';
import type { DoomFooterContributionDefinition, DoomFooterContributionHandle } from './footer.ts';
import type { DoomLeaderActionHandlerOptions, DoomLeaderContributionHandle, LeaderContribution } from './leader.ts';

/** The application-scoped UI aggregation service owned by doompi-ui. */
export const DOOM_UI_HUB_SERVICE = 'doom/ui-hub';

/** Direct, process-local aggregation for optional UI contributions. */
export interface DoomUiHubService {
  registerLeader(contribution: LeaderContribution): DoomLeaderContributionHandle;
  registerLeaderActions<ExtensionContext extends DoomExtensionContext = DoomExtensionContext>(
    options: DoomLeaderActionHandlerOptions<ExtensionContext>,
  ): () => void;
  registerFooter(definition: DoomFooterContributionDefinition): DoomFooterContributionHandle;
  registerConfig<ExtensionContext extends DoomExtensionContext = DoomExtensionContext>(
    options: DoomConfigContributionOptions<ExtensionContext>,
  ): DoomConfigContributionHandle;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/ui-hub': DoomUiHubService;
  }
}

export function readDoomUiHub(context: Context): DoomUiHubService | undefined {
  return context.get(DOOM_UI_HUB_SERVICE) as DoomUiHubService | undefined;
}

export function requireDoomUiHub(context: Context): DoomUiHubService {
  const hub = readDoomUiHub(context);
  if (!hub) throw new Error('Doom UI hub is unavailable. Load @agimon-ai/doompi-ui.');
  return hub;
}
