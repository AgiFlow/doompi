import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { VoiceToolMessage } from '../../../../../web/components/VoiceToolMessage';
import { VOICE_DESCRIBE_TOOL, VOICE_TRANSFER_TOOL, VOICE_USE_TOOL } from '../../../../../web/lib/voiceToolRender';

export default defineToolRenderer({
  tools: [VOICE_DESCRIBE_TOOL, VOICE_USE_TOOL, VOICE_TRANSFER_TOOL],
  message: VoiceToolMessage,
});
