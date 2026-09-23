import { defineToolRestriction } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomHeadlessToolRestriction } from '@agimon-ai/doompi-core/headless';
import { DOOM_VOICE_AUTO_MODE_ID } from '@agimon-ai/doompi-core/voiceTools';

import { ASK_USER_QUESTION_TOOL_NAME } from '../../../../../constants/tool';

export default defineToolRestriction({
  when: { state: { 'minor-mode': DOOM_VOICE_AUTO_MODE_ID } },
  excludedTools: [ASK_USER_QUESTION_TOOL_NAME],
} satisfies DoomHeadlessToolRestriction);
