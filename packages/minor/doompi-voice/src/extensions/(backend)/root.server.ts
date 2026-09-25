import { join } from 'node:path';

import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { DoomApi } from '@agimon-ai/doompi-core/packageApi';
import type { DoomServerPluginContext, DoomServerRegistration } from '@agimon-ai/doompi-core/serverFacet';
import { parseRemoteSessionReference } from '@agimon-ai/doompi-session';

import { VoiceMediaBroker } from '../../services/clientMediaApi';
import { GlobalLiveCompanion } from '../../services/globalLiveCompanion';
import type { GlobalLiveNativeTransfer, GlobalLiveReceipts } from '../../services/globalLiveCompanion/type';
import { createRealtimeRuntime } from '../../services/realtimeRuntime';
import { createVoiceMediaWakeChannel, createVoiceOwnershipChannel } from '../../services/voiceMediaHubChannel';
import type { VoiceOwnershipCoordinator } from '../../services/voiceOwnershipCoordinator';
import { isPairedVoiceTargetGranted } from '../../services/voicePeerRelay';
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
  let coordinator: VoiceOwnershipCoordinator | undefined;
  const mediaApi: DoomApi = { basePath: VOICE_MEDIA_API_BASE_PATH, start: () => broker };
  const voiceApi: DoomApi = {
    basePath: 'voice',
    start(apiContext) {
      const readiness = voiceReadinessApi.start(apiContext);
      const live = companion.api.start(apiContext);
      return {
        async fetch(request) {
          if (new URL(request.url).pathname === '/live/native-transfer') {
            if (!apiContext.hubToken || request.headers.get('authorization') !== `Bearer ${apiContext.hubToken}`)
              return Response.json({ error: 'Unauthorized.' }, { status: 401 });
            if (request.method !== 'POST') return Response.json({ error: 'Not found.' }, { status: 404 });
            const input = (await request.json().catch(() => undefined)) as
              | Partial<GlobalLiveNativeTransfer>
              | undefined;
            if (
              !input ||
              typeof input.sourceSessionId !== 'string' ||
              !input.sourceSessionId ||
              input.sourceSessionId.length > 256 ||
              typeof input.activationId !== 'string' ||
              !input.activationId ||
              input.activationId.length > 256 ||
              !Number.isSafeInteger(input.routeGeneration) ||
              typeof input.sessionIncarnation !== 'string' ||
              !input.sessionIncarnation ||
              input.sessionIncarnation.length > 256 ||
              !Number.isSafeInteger(input.ordinal) ||
              (input.ordinal ?? 0) < 1 ||
              typeof input.catalogRevision !== 'string' ||
              !input.catalogRevision ||
              input.catalogRevision.length > 256
            )
              return Response.json({ error: 'Invalid native Voice transfer.' }, { status: 400 });
            try {
              return Response.json(
                companion.nativeTransfer(input as GlobalLiveNativeTransfer, (source, ordinal, revision) => {
                  const target = coordinator?.resolveLiveTarget(source, ordinal, revision);
                  return target &&
                    (parseRemoteSessionReference(target) === undefined ||
                      isPairedVoiceTargetGranted(context.homeDirectory!, target))
                    ? target
                    : undefined;
                }),
                { status: 202 },
              );
            } catch (error) {
              return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
            }
          }
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
  let ownershipRegistration: DoomServerRegistration | undefined;
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
      ownershipRegistration = host.registerChannel(
        createVoiceOwnershipChannel(
          (owner) => {
            coordinator = owner;
            companion.setCatalog(owner);
          },
          () => {
            coordinator = undefined;
            companion.setCatalog(undefined);
          },
          () => {
            void companion
              .refreshSelectedCatalog()
              .catch((error: unknown) =>
                context.onNotice(
                  `Global Voice catalog update failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
          },
        ),
      );
      if (!ownershipRegistration.mounted) throw new Error('Global Voice could not claim its ownership channel.');
    },
    async onStop() {
      await companion.close();
      ownershipRegistration?.dispose();
      coordinator = undefined;
      channelRegistration?.dispose();
    },
  };
});
