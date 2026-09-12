import type { Context } from '@deepseek-ai/cordis';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { COMMAND_NAME } from '../../constants/prompts';
import {
  LEADER_BINDING_PREFIX,
  LEADER_DETAIL,
  LEADER_GROUP,
  LEADER_KEY,
  LEADER_LABEL,
  PACKAGE_SOURCE,
} from '../../constants/prompt';

/** Puts the picker on the leader map, and takes it back off on dispose. */
export function registerLeaderContribution(hub: DoomUiHubService): () => void {
  const contribution = hub.registerLeader({
    source: PACKAGE_SOURCE,
    bindings: [
      {
        id: `${LEADER_BINDING_PREFIX}.open`,
        path: [LEADER_GROUP, { key: LEADER_KEY, label: LEADER_LABEL, detail: LEADER_DETAIL }],
        command: { name: COMMAND_NAME },
      },
    ],
  });
  return () => contribution.dispose();
}

export function promptLeaderService(context: Context): void {
  context.inject([DOOM_UI_HUB_SERVICE], (uiContext) => registerLeaderContribution(requireDoomUiHub(uiContext)));
}
