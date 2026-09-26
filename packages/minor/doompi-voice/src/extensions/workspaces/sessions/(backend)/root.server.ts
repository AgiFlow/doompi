import { join } from 'node:path';

import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomApi } from '@agimon-ai/doompi-core/packageApi';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

import { VOICE_API_BASE_PATH } from '../../../../constants/voice';
import { VoiceMediaBroker } from '../../../../services/clientMediaApi';
import { createRealtimeRuntime } from '../../../../services/realtimeRuntime';
import { registerVoicePeerBroker } from '../../../../services/voicePeerRelay';
import { createVoiceServer } from '../../../../services/voiceServer';
import { createVoiceSessionApi } from '../../../../services/voiceSessionApi';
import { VOICE_MEDIA_API_BASE_PATH } from '../../../../types/clientMedia';

export default defineRoot(({ agent, host }: DoomServerPluginContext) => {
  const { directEvents, homeDirectory, sessionId, internalToken, hubToken } = host.context;
  if (!agent || !directEvents || !homeDirectory)
    throw new Error('Voice requires a native session host, media event bus, and server home.');
  const broker = new VoiceMediaBroker({
    directEvents,
    sessionId,
    internalToken,
    hubToken,
    mediaArbitration: host.context.mediaArbitration,
    realtimeProvider: createRealtimeRuntime({ stateDirectory: join(homeDirectory, '.pi', '.doom') }).provider,
  });
  const voice = createVoiceServer(
    agent,
    broker,
    homeDirectory,
    hubToken,
    host.context.peerAgents,
    host.context.requestApi === undefined
      ? undefined
      : (mount, basePath, request) => host.context.requestApi!(mount, basePath, request),
  );
  const voiceApi = voice.api?.find((api) => api.basePath === VOICE_API_BASE_PATH);
  if (voiceApi === undefined) throw new Error('Voice server did not provide its session API.');
  const mediaApi: DoomApi = {
    basePath: VOICE_MEDIA_API_BASE_PATH,
    start: () =>
      createVoiceSessionApi({ directEvents, media: broker, projectRoot: agent.context.repoRoot, homeDirectory }),
  };
  // Named, so each route mounts its API by identity rather than by position in the list.
  const value = { ...voice, api: [...(voice.api ?? []), mediaApi], voiceApi, mediaApi };
  return {
    value,
    services: [...(value.services ?? []), () => registerVoicePeerBroker(agent.context.sessionId, broker)],
    activities: value.activities,
    onStart: value.onStart,
    onStop: value.onStop,
    onDispose: value.onDispose,
  };
});
