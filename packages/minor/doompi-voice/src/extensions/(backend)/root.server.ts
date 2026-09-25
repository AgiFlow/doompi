import { join } from 'node:path';

import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomApi } from '@agimon-ai/doompi-core/packageApi';
import type { DoomServerPluginContext, DoomServerRegistration } from '@agimon-ai/doompi-core/serverFacet';

import { VoiceMediaBroker } from '../../services/clientMediaApi';
import { GlobalLiveCompanion } from '../../services/globalLiveCompanion';
import type { GlobalLiveReceipts } from '../../services/globalLiveCompanion/type';
import { createRealtimeRuntime } from '../../services/realtimeRuntime';
import { createVoiceMediaWakeChannel } from '../../services/voiceMediaHubChannel';
import { voiceReadinessApi } from '../../services/voiceReadinessApi';
import { VOICE_MEDIA_API_BASE_PATH } from '../../types/clientMedia';

/** Recreated at narrower mounts by the entry generator; only the global mount owns a companion. */
export default defineRoot<{ voiceApi?: DoomApi; mediaApi?: DoomApi }, DoomServerPluginContext>(({ host }) => {
  if (host.scope !== 'global') return { value: { voiceApi: undefined, mediaApi: undefined } };
  const context = host.context;
  if (!context.homeDirectory) throw new Error('Global Voice requires the configured server home.');
  const receipts = (context as typeof context & { requestReceipts?: GlobalLiveReceipts }).requestReceipts;
  let companion: GlobalLiveCompanion;
  const broker = new VoiceMediaBroker({
    globalLive: { ready: () => companion?.mediaReady() ?? false },
    sessionId: 'global-live-companion',
    mediaArbitration: context.mediaArbitration,
    realtimeProvider: createRealtimeRuntime({ stateDirectory: join(context.homeDirectory, '.pi', '.doom') }).provider,
  });
  companion = new GlobalLiveCompanion({
    broker,
    receipts,
    homeDirectory: context.homeDirectory,
    onNotice: (message) => context.onNotice(message),
  });
  const mediaApi: DoomApi = { basePath: VOICE_MEDIA_API_BASE_PATH, start: () => broker };
  const voiceApi: DoomApi = {
    basePath: 'voice',
    start(apiContext) {
      const readiness = voiceReadinessApi.start(apiContext);
      const live = companion.api.start(apiContext);
      return {
        fetch(request) {
          return new URL(request.url).pathname.startsWith('/live/') ? live.fetch(request) : readiness.fetch(request);
        },
        close() {
          live.close();
          readiness.close();
        },
      };
    },
  };
  let channelRegistration: DoomServerRegistration | undefined;
  return {
    value: { voiceApi, mediaApi },
    onStart() {
      const channel = createVoiceMediaWakeChannel();
      channelRegistration = host.registerChannel({
        ...channel,
        start(hub) {
          companion.bind(hub);
          const source = channel.start(hub);
          return {
            ...source,
            close() {
              companion.unbind(hub);
              source.close();
            },
          };
        },
      });
      if (!channelRegistration.mounted) throw new Error('Global Voice could not claim its hub channel.');
    },
    async onStop() {
      await companion.close();
      channelRegistration?.dispose();
    },
  };
});
