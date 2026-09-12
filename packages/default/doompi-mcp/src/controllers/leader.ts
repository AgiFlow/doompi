import type { DoomUiHubService } from '@agimon-ai/doompi-core/ui-hub';
import { COMMAND_NAME } from '../constants/mcp';
import {
  LEADER_BINDING_PREFIX,
  LEADER_DETAIL,
  LEADER_GROUP,
  LEADER_KEY,
  LEADER_LABEL,
  PACKAGE_SOURCE,
} from '../constants/piMcp';

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
