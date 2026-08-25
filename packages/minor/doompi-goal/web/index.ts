import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { GoalToolMessage } from './GoalToolMessage.tsx';
import { GOAL_TOOL_NAMES } from './goalToolRender.ts';

const GOAL_GROUP = { key: 'g', label: 'goal', detail: 'session objective' };

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports through the 'goal' footer status.
 * The leader keys are the TUI's SPC g e and SPC g g, routed through the slash
 * commands an RPC client can send; the history overlay (g l) is TUI-only.
 */
export const webPlugin = defineWebPlugin({
  id: 'goal',
  minorModes: [{ name: 'goal', keys: 'g e', statusKey: 'goal', order: 40 }],
  // The goal tools' timeline cards; the TUI leaves these on Pi's default shell.
  toolRenderers: [{ tools: [...GOAL_TOOL_NAMES], message: GoalToolMessage }],
  leaderBindings: [
    {
      id: 'goal.toggle',
      path: [GOAL_GROUP, { key: 'e', label: 'toggle', detail: 'start a session goal or end the current one' }],
      command: 'minor goal',
    },
    {
      id: 'goal.show',
      path: [GOAL_GROUP, { key: 'g', label: 'current', detail: 'the goal being worked' }],
      command: 'goal status',
    },
  ],
});
