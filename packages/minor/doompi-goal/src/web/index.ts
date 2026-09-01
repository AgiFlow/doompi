import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { GOAL_VIEW_STATUS_KEY } from '../types/goalView.ts';
import { GoalActivitySection } from './GoalActivitySection.tsx';
import { GoalToolMessage } from './GoalToolMessage.tsx';
import { GOAL_TOOL_NAMES } from './goalToolRender.ts';

const GOAL_GROUP = { key: 'g', label: 'goal', detail: 'session objective' };

/**
 * This package's cockpit presence. The selection bar renders the minor-mode
 * entry and folds in what the session reports through the 'goal' footer status;
 * the activity dock carries the objective itself.
 * The leader keys are the TUI's SPC g e and SPC g g, routed through the slash
 * commands an RPC client can send; the history overlay (g l) is TUI-only.
 */
export const webPlugin = defineWebPlugin({
  id: 'goal',
  minorModes: [{ name: 'goal', keys: 'g e', statusKey: 'goal', order: 40 }],
  // Keyed off its own status rather than the mode's, because the objective
  // outlives the mode and the footer's terse 'goal' carries no objective to
  // show. There is no `tab`: the goal is one line, so the row is the whole of
  // it, and the chip stays the label for the TUI's SPC g e.
  // hideWhenEmpty: the row is the goal, so with no goal there is nothing to
  // put under the header, and the group waits until a session sets one.
  activityGroups: [{ name: 'goal', keys: 'g e', statusKey: GOAL_VIEW_STATUS_KEY, hideWhenEmpty: true, order: 35 }],
  // Same name as the group: the dock renders this inside it, in place of the
  // raw status line the session publishes.
  activitySections: [{ id: 'goal', component: GoalActivitySection }],
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
