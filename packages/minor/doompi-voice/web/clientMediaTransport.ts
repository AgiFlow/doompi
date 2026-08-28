import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import {
  VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER,
  VOICE_MEDIA_ACTIVITY_EPOCH_HEADER,
  VOICE_MEDIA_ACTIVITY_LEVEL_HEADER,
  VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER,
  VOICE_MEDIA_ACTIVITY_STATE_HEADER,
  type VoiceMediaCaptureActivity,
  VOICE_MEDIA_CONTENT_TYPE,
  type VoiceMediaClientEvent,
  type VoiceMediaConnectResult,
  type VoiceMediaCapabilities,
  type VoiceMediaPlaybackResult,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_ROUTES,
  type VoiceMediaTransport,
  voiceMediaClientUrl,
} from '../src/types/clientMedia.ts';

const JSON_CONTENT_TYPE = 'application/json';

async function responseError(response: Response): Promise<Error> {
  let message = `Voice media request failed with status ${String(response.status)}.`;
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // A response without JSON still carries its HTTP status above.
  }
  return new Error(message);
}

function jsonBody(value: object): RequestInit {
  return { method: 'POST', headers: { 'content-type': JSON_CONTENT_TYPE }, body: JSON.stringify(value) };
}

export class BrowserVoiceMediaTransport implements VoiceMediaTransport {
  public constructor(private readonly sessionId: string) {}

  public async connect(
    clientId: string,
    connectionId: string,
    capabilities: VoiceMediaCapabilities,
  ): Promise<VoiceMediaConnectResult> {
    const response = await sealedTransport.fetch(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientConnect),
      jsonBody({
        version: VOICE_MEDIA_PROTOCOL_VERSION,
        clientId,
        connectionId,
        clientKind: 'browser',
        controlLocation: sealedTransport.active() ? 'remote' : 'local',
        capabilities,
      }),
    );
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as VoiceMediaConnectResult;
  }

  public async disconnect(clientId: string, connectionId: string): Promise<void> {
    const response = await sealedTransport.fetch(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientDisconnect),
      jsonBody({ clientId, connectionId }),
    );
    if (!response.ok && response.status !== 409) throw await responseError(response);
  }

  public async nextEvent(
    clientId: string,
    connectionId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<VoiceMediaClientEvent | undefined> {
    const response = await sealedTransport.fetch(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientEvents, {
        clientId,
        connectionId,
        after: String(after),
      }),
      { signal },
    );
    if (response.status === 204) return undefined;
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as VoiceMediaClientEvent;
  }

  public async sendAudio(
    clientId: string,
    connectionId: string,
    captureId: string,
    pcm: Uint8Array,
    activity?: VoiceMediaCaptureActivity,
  ): Promise<void> {
    const response = await sealedTransport.fetch(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientAudio, { clientId, connectionId, captureId }),
      {
        method: 'POST',
        headers: {
          'content-type': VOICE_MEDIA_CONTENT_TYPE,
          ...(activity === undefined
            ? {}
            : {
                [VOICE_MEDIA_ACTIVITY_STATE_HEADER]: activity.state,
                [VOICE_MEDIA_ACTIVITY_LEVEL_HEADER]: String(activity.levelDbfs),
                [VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER]: String(activity.elapsedMs),
                ...(activity.epoch === undefined
                  ? {}
                  : { [VOICE_MEDIA_ACTIVITY_EPOCH_HEADER]: String(activity.epoch) }),
                ...(activity.classifiedSpeechMs === undefined
                  ? {}
                  : { [VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER]: String(activity.classifiedSpeechMs) }),
              }),
        },
        body: new Blob([new Uint8Array(pcm)], { type: VOICE_MEDIA_CONTENT_TYPE }),
      },
    );
    if (!response.ok) throw await responseError(response);
  }

  public async captureStopped(
    clientId: string,
    connectionId: string,
    captureId: string,
    error?: string,
  ): Promise<void> {
    const response = await sealedTransport.fetch(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientCaptureStopped),
      jsonBody({ clientId, connectionId, captureId, ...(error === undefined ? {} : { error }) }),
    );
    if (!response.ok) throw await responseError(response);
  }

  public async playbackFinished(
    clientId: string,
    connectionId: string,
    result: VoiceMediaPlaybackResult,
  ): Promise<void> {
    const response = await sealedTransport.fetch(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientPlaybackResult),
      jsonBody({ clientId, connectionId, ...result }),
    );
    if (!response.ok) throw await responseError(response);
  }
}
