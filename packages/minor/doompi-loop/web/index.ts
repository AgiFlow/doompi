import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports through the 'doom-loop' footer status.
 */
const LOOPS_GROUP = { key: 'l', label: 'loops', detail: 'recurring prompt loops' };

export const webPlugin = defineWebPlugin({
  id: 'loop',
  minorModes: [{ name: 'loop', keys: 'l l', statusKey: 'doom-loop', order: 30 }],
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
