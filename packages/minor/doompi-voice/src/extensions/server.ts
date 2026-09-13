import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { createVoiceMediaWakeChannel, createVoiceOwnershipChannel } from '../controllers/voiceMediaHubChannel';
import { createVoiceServer } from '../controllers/voiceServer';
import { api } from '../controllers/voiceSessionApi';
export const voiceServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-voice',
  global: { channels: [createVoiceMediaWakeChannel, createVoiceOwnershipChannel] },
  workspace: { channels: [createVoiceMediaWakeChannel, createVoiceOwnershipChannel] },
  session: ({ agent }) => ({ ...(agent ? createVoiceServer(agent) : {}), api: [api] }),
});
export default voiceServerFacet;
