import { defineSlot, defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { LOOP_VIEW_STATUS_KEY } from '../types/loopView.ts';
import { LoopActivityItems, LoopsActivitySection } from './components/LoopsActivitySection.tsx';

/**
 * This package's cockpit presence. The selection bar carries the minor mode,
 * while the activity dock shows each loop the active session is scheduling.
 */
const LOOPS_GROUP = { key: 'l', label: 'loops', detail: 'recurring prompt loops' };
const LOOPS_ACTIVITY_SOURCE = {
  subscribe: () => () => undefined,
  // Keeping the scheduler's launcher visible does not mean a result is pending.
  isActive: (_sessionId: string | null) => false,
};

export const webPlugin = defineWebPlugin({
  id: 'loop',
  session: {
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
  },
});
