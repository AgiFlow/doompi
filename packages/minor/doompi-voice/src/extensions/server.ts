import { join } from 'node:path';

import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';

import { VoiceMediaBroker } from '../controllers/clientMediaApi';
import { voiceClientSettingsApi } from '../controllers/voiceClientSettingsApi';
import { createVoiceMediaWakeChannel, createVoiceOwnershipChannel } from '../controllers/voiceMediaHubChannel';
import { createVoiceServer } from '../controllers/voiceServer';
import { createVoiceSessionApi } from '../controllers/voiceSessionApi';
import { createRealtimeRuntime } from '../services/realtimeRuntime';
export const voiceServerFacet = defineServerPlugin({
  name: '@agimon-ai/doompi-voice',
  global: { api: [voiceClientSettingsApi], channels: [createVoiceMediaWakeChannel, createVoiceOwnershipChannel] },
  workspace: { channels: [createVoiceMediaWakeChannel, createVoiceOwnershipChannel] },
  session: ({ agent, host }) => {
    const { directEvents, homeDirectory, sessionId, internalToken, hubToken } = host.context;
    if (!agent || !directEvents || !homeDirectory)
      throw new Error('Voice requires a native session host, media event bus, and server home.');
    const broker = new VoiceMediaBroker({
      directEvents,
      sessionId,
      internalToken,
      hubToken,
      realtimeProvider: createRealtimeRuntime({ stateDirectory: join(homeDirectory, '.pi', '.doom') }).provider,
    });
    const voice = createVoiceServer(agent, broker, homeDirectory);
    return {
      ...voice,
      api: [
        ...(voice.api ?? []),
        {
          basePath: 'voice-media',
          start: () =>
            createVoiceSessionApi({ directEvents, media: broker, projectRoot: agent.context.repoRoot, homeDirectory }),
        },
      ],
    };
  },
});
export default voiceServerFacet;
