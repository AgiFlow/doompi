import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';
import { defineSlot } from '@agimon-ai/doompi-core/web';

import { LOOP_VIEW_STATUS_KEY } from '../../../../types/loopView';
import { LoopActivityItems, LoopsActivitySection } from '../../../../web/components/LoopsActivitySection';
const LOOPS_GROUP = { key: 'l', label: 'loops', detail: 'recurring prompt loops' };
const LOOPS_ACTIVITY_SOURCE = {
  subscribe: () => () => undefined,
  // Keeping the scheduler's launcher visible does not mean a result is pending.
  isActive: (_sessionId: string | null) => false,
};

export default {
  minorModes: [{ name: 'loop', keys: 'l l', statusKey: 'doom-loop', activityGroup: 'loops', order: 30 }],
  activityGroups: [
    { name: 'loops', keys: 'l l', statusKey: LOOP_VIEW_STATUS_KEY, activeSource: LOOPS_ACTIVITY_SOURCE, order: 40 },
  ],
  activitySections: [{ id: 'loops', component: LoopsActivitySection }],
  slots: [defineSlot({ slot: 'loop.registration' }), defineSlot({ slot: 'loop.items' })],
  fills: [{ slot: 'loop.items', id: 'instances', component: LoopActivityItems }],
  // The TUI's SPC l s and SPC l l: both are slash commands, so both carry over.
  leaderBindings: [
    {
      id: 'loop.start',
      path: [LOOPS_GROUP, { key: 's', label: 'start', detail: 'begin a recurring loop' }],
      command: 'loop',
    },
    {
      id: 'loop.list',
      path: [LOOPS_GROUP, { key: 'l', label: 'list', detail: 'loops in this session' }],
      command: 'loops',
    },
  ],
} satisfies NonNullable<WebPluginDefinition['session']>;
