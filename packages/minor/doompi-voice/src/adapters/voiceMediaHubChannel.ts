import type { HubChannelSource, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { VOICE_MEDIA_WAKE_TYPE, type VoiceMediaWake } from '../types/clientMedia.ts';
import { type VoiceMediaWakeSource, watchVoiceMediaWake } from './voiceMediaWakeFile.ts';

export function createVoiceMediaWakeChannel(watch: typeof watchVoiceMediaWake = watchVoiceMediaWake): WebHubChannel {
  return {
    frameType: VOICE_MEDIA_WAKE_TYPE,
    start(host) {
      const latest = new Map<string, VoiceMediaWake>();
      const sources = new Map<string, VoiceMediaWakeSource>();
      const source: HubChannelSource = {
        payloadFor(scope) {
          return latest.get(scope.sessionId);
        },
        sessionAdded(scope) {
          sources.get(scope.sessionId)?.close();
          sources.set(
            scope.sessionId,
            watch(scope.sessionId, (wake) => {
              if (wake === undefined) {
                latest.delete(scope.sessionId);
                return;
              }
              latest.set(scope.sessionId, wake);
              host.publish(scope.sessionId, wake);
            }),
          );
        },
        sessionRemoved(sessionId) {
          sources.get(sessionId)?.close();
          sources.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          for (const wakeSource of sources.values()) wakeSource.close();
          sources.clear();
          latest.clear();
        },
      };
      return source;
    },
  };
}

export const webHubChannels: readonly WebHubChannel[] = [createVoiceMediaWakeChannel()];
