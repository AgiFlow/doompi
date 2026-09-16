import { defineToolRenderer } from '@agimon-ai/doompi-core/web';

import { VoiceToolMessage } from '../../../../../web/components/VoiceToolMessage';
import { VOICE_NARRATE_TOOL } from '../../../../../web/lib/voiceToolRender';

export default defineToolRenderer({
  tools: [VOICE_NARRATE_TOOL],
  timelinePresentation: 'message',
  message: VoiceToolMessage,
});
