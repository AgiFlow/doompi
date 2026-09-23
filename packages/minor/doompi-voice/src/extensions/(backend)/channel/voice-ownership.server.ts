import { defineChannel } from '@agimon-ai/doompi-core/extensionFile';

import { createVoiceOwnershipChannel } from '../../../services/voiceMediaHubChannel';

export default defineChannel(createVoiceOwnershipChannel);
