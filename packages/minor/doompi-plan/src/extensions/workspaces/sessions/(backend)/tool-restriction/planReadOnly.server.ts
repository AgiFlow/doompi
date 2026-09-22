import { defineToolRestriction } from '@agimon-ai/doompi-core/extension-file';
import type { DoomHeadlessToolRestriction } from '@agimon-ai/doompi-core/headless';

export default defineToolRestriction({
  when: { state: { 'minor-mode': 'plan' } },
  excludedTools: ['edit', 'write'],
} satisfies DoomHeadlessToolRestriction);
