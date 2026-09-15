import { join } from 'node:path';

import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';

import { VoiceMediaBroker } from '../../../../services/clientMediaApi';
import { createRealtimeRuntime } from '../../../../services/realtimeRuntime';
import { createVoiceServer } from '../../../../services/voiceServer';
import { createVoiceSessionApi } from '../../../../services/voiceSessionApi';

export default defineRoot(({ agent, host }: DoomServerPluginContext) => {
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
  const value = {
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
  return {
    value,
    services: value.services,
    activities: value.activities,
    onStart: value.onStart,
    onStop: value.onStop,
    onDispose: value.onDispose,
  };
});
