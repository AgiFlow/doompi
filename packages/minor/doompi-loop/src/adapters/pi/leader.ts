import type { DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { LIST_COMMAND_NAME, START_COMMAND_NAME } from '../../schemas/loopCommands.ts';
import { LOOPS_GROUP_ORDER, PACKAGE_SOURCE } from './loopConstants.ts';

const LOOPS_GROUP_SEGMENT = {
  key: 'l',
  label: 'loops',
  detail: 'recurring prompt loops',
  order: LOOPS_GROUP_ORDER,
} as const;

export function registerLeaderContribution(hub: DoomUiHubService): () => void {
  const contribution = hub.registerLeader({
    source: PACKAGE_SOURCE,
    bindings: [
      {
        id: 'loop.start',
        path: [LOOPS_GROUP_SEGMENT, { key: 's', label: 'start', detail: 'begin a recurring loop' }],
        command: { name: START_COMMAND_NAME },
      },
      {
        id: 'loop.list',
        path: [LOOPS_GROUP_SEGMENT, { key: 'l', label: 'list', detail: 'loops in this session' }],
        command: { name: LIST_COMMAND_NAME },
      },
    ],
  });
  return () => contribution.dispose();
}
