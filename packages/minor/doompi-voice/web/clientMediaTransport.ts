import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import {
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

  public async sendAudio(clientId: string, connectionId: string, captureId: string, pcm: Uint8Array): Promise<void> {
    const response = await sealedTransport.fetch(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientAudio, { clientId, connectionId, captureId }),
      {
        method: 'POST',
        headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE },
        body: new Blob([new Uint8Array(pcm)], { type: VOICE_MEDIA_CONTENT_TYPE }),
      },
    );
    if (!response.ok) throw await responseError(response);
  }

  public async captureStopped(clientId: string, connectionId: string, captureId: string): Promise<void> {
    const response = await sealedTransport.fetch(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientCaptureStopped),
      jsonBody({ clientId, connectionId, captureId }),
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
