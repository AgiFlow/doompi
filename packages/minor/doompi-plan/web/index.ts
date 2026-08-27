import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { PLAN_STATUS_KEY } from '../src/types/planApi.ts';
import { PlanActivitySection } from './PlanActivitySection.tsx';
import { planSettingsSection } from './planSettings.ts';
import { PlanToolMessage } from './PlanToolMessage.tsx';
import { PLAN_TOOL_NAMES } from './planToolRender.ts';

/**
 * This package's cockpit presence. The selection bar renders the minor-mode
 * entry and folds in what the session reports through the 'plan-mode' footer
 * status; the activity dock carries the plan itself.
 */
export const webPlugin = defineWebPlugin({
  id: 'plan',
  minorModes: [{ name: 'plan', keys: 'p e', statusKey: 'plan-mode', order: 20 }],
  // Keyed off the plan the session wrote rather than the mode, because the
  // plan outlives the mode: exiting is when the agent starts implementing,
  // which is when a reader most wants it open. There is no `tab`, so the chip
  // stays the label for the TUI's SPC p e; the section's row is the way in,
  // and a leader binding could not open a transient tab anyway.
  activityGroups: [{ name: 'plan', keys: 'p e', statusKey: PLAN_STATUS_KEY, order: 25 }],
  // Same name as the group: the dock renders this inside it, in place of the
  // raw status line the session publishes for a terminal footer.
  activitySections: [{ id: 'plan', component: PlanActivitySection }],
  // The same five fields the TUI's SPC e c panel draws, from one descriptor
  // table; the host renders them and owns which config file an edit lands in.
  settingsSections: [planSettingsSection],
  // The plan tools' timeline cards; the TUI leaves these on Pi's default shell.
  toolRenderers: [{ tools: [...PLAN_TOOL_NAMES], message: PlanToolMessage }],
  // The TUI's SPC p e through /minor, which asks for the flavor; the direct
  // debug (p d) and fable (p f) keys are leader actions the RPC road lacks.
  leaderBindings: [
    {
      id: 'plan.toggle',
      path: [
        { key: 'p', label: 'plan', detail: 'read-only planning modes' },
        { key: 'e', label: 'toggle', detail: 'enter or leave read-only planning' },
      ],
      command: 'minor plan',
    },
  ],
});
