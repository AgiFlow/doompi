import { defineToolRestriction } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomHeadlessToolRestriction } from '@agimon-ai/doompi-core/headless';

export default defineToolRestriction({
  when: { state: { 'minor-mode': 'plan' } },
  excludedTools: ['edit', 'write'],
} satisfies DoomHeadlessToolRestriction);
