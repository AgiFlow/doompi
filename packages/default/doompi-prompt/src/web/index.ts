import { defineWebPlugin } from '@agimon-ai/doompi-web-contracts';
import { PromptsActivitySection } from './PromptsActivitySection.tsx';

/**
 * This package's cockpit presence: one activity group.
 *
 * No tab. The library is not a place to sit in, it is something reached for
 * mid-conversation, so it lives in the activity dock next to agents, runners
 * and workflows, and the picking happens in a dialog over the conversation.
 *
 * The group is always visible and never claims background work: saving a
 * prompt is not a running job, and an empty library still needs the entry
 * point that fills it.
 */
const promptsActivitySource = {
  subscribe: () => () => undefined,
  isActive: () => false,
};

export const webPlugin = defineWebPlugin({
  id: 'prompts',
  activityGroups: [
    {
      name: 'prompts',
      // The TUI's SPC e p, so the two surfaces are reached the same way.
      keys: 'e p',
      activeSource: promptsActivitySource,
      order: 40,
    },
  ],
  activitySections: [{ id: 'prompts', component: PromptsActivitySection }],
});
