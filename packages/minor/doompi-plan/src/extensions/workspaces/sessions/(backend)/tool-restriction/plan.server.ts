import { defineToolRestriction } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomHeadlessToolRestriction } from '@agimon-ai/doompi-core/headless';
import { DOOM_VOICE_AUTO_MODE_ID } from '@agimon-ai/doompi-core/voiceTools';

export default defineToolRestriction({
  when: { state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID } },
  excludedTools: ['complete_plan'],
} satisfies DoomHeadlessToolRestriction);
