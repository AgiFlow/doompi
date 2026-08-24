import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { PlanCall, PlanResult } from './PlanToolCard.tsx';
import { PLAN_TOOL_NAMES } from './planToolRender.ts';

/**
 * This package's cockpit presence: pure metadata. The selection bar renders
 * the minor-mode entry and folds in what the session reports through the 'plan-mode' footer status.
 */
export const webPlugin = defineWebPlugin({
  id: 'plan',
  minorModes: [{ name: 'plan', keys: 'p e', statusKey: 'plan-mode', order: 20 }],
  // The plan tools' timeline cards; the TUI leaves these on Pi's default shell.
  toolRenderers: [{ tools: [...PLAN_TOOL_NAMES], call: PlanCall, result: PlanResult }],
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
