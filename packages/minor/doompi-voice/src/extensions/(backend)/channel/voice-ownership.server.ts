import { defineChannel } from '@agimon-ai/doompi-core/extension-file';

import { createVoiceOwnershipChannel } from '../../../services/voiceMediaHubChannel';

export default defineChannel(createVoiceOwnershipChannel);
