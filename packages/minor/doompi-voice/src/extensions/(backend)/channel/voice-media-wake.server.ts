import { defineChannel } from '@agimon-ai/doompi-core/extension-file';

import { createVoiceMediaWakeChannel } from '../../../services/voiceMediaHubChannel';

export default defineChannel(createVoiceMediaWakeChannel);
