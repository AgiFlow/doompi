import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { VoiceToolMessage } from './_components/VoiceToolMessage';
import { VOICE_DESCRIBE_TOOL, VOICE_TRANSFER_TOOL, VOICE_USE_TOOL } from './_lib/voiceToolRender';

export default defineToolRenderer({
  tools: [VOICE_DESCRIBE_TOOL, VOICE_USE_TOOL, VOICE_TRANSFER_TOOL],
  message: VoiceToolMessage,
});
