import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { LOOP_VIEW_STATUS_KEY } from '../src/types/loopView.ts';
import { LoopsActivitySection } from './LoopsActivitySection.tsx';

/**
 * This package's cockpit presence. The selection bar carries the minor mode,
 * while the activity dock shows each loop the active session is scheduling.
 */
const LOOPS_GROUP = { key: 'l', label: 'loops', detail: 'recurring prompt loops' };

export const webPlugin = defineWebPlugin({
  id: 'loop',
  minorModes: [{ name: 'loop', keys: 'l l', statusKey: 'doom-loop', order: 30 }],
  activityGroups: [{ name: 'loops', keys: 'l l', statusKey: LOOP_VIEW_STATUS_KEY, hideWhenEmpty: true, order: 40 }],
  activitySections: [{ id: 'loops', component: LoopsActivitySection }],
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
});
