import { defineChannel } from '@agimon-ai/doompi-core/extensionFile';

import { createVoiceMediaWakeChannel } from '../../../../services/voiceMediaHubChannel';

export default defineChannel(createVoiceMediaWakeChannel);
