import type { WebPluginDefinition } from '@agimon-ai/doompi-core/web';

import { PLAN_STATUS_KEY } from '../../../../types/planApi';
import { PlanActivitySection } from '../../../../web/components/PlanActivitySection';
import { claimsPlanReviewPrompt, PlanReviewPrompt } from '../../../../web/components/PlanReviewPrompt';
import { PlanToolMessage } from '../../../../web/components/PlanToolMessage';
import { PLAN_TOOL_NAMES } from '../../../../web/lib/planToolRender';

export default {
  minorModes: [{ name: 'plan', keys: 'p e', statusKey: 'plan-mode', order: 20 }],
  // Keyed off the plan the session wrote rather than the mode, because the
  // plan outlives the mode: exiting is when the agent starts implementing,
  // which is when a reader most wants it open. There is no `tab`, so the chip
  // stays the label for the TUI's SPC p e; the section's row is the way in,
  // and a leader binding could not open a transient tab anyway.
  // `marksBackgroundWork: false`: a saved plan is a document, not a running
  // process, so it must not count toward the dock's "N running" badge.
  activityGroups: [{ name: 'plan', keys: 'p e', statusKey: PLAN_STATUS_KEY, marksBackgroundWork: false, order: 25 }],
  // Same name as the group: the dock renders this inside it, in place of the
  // raw status line the session publishes for a terminal footer.
  activitySections: [{ id: 'plan', component: PlanActivitySection }],
  // The complete_plan selector takes over the composer so the plan remains visible
  // while the reader decides whether implementation should begin.
  toolRenderers: [
    {
      tools: [...PLAN_TOOL_NAMES],
      message: PlanToolMessage,
      prompt: { claims: claimsPlanReviewPrompt, component: PlanReviewPrompt },
    },
  ],
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
} satisfies NonNullable<WebPluginDefinition['session']>;
