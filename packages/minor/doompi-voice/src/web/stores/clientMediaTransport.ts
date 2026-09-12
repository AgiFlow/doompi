import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { REALTIME_ROUTES, type RealtimeBrowserState } from '../../types/realtime';
import {
  VOICE_MEDIA_ACTIVITY_ECHO_SPEECH_MS_HEADER,
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
  VOICE_MEDIA_EVENT_WAIT_NONE,
  type VoiceMediaPlaybackResult,
  VOICE_MEDIA_PLAYBACK_STATE_HEADER,
  type VoiceMediaWake,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_ROUTES,
  type VoiceMediaTransport,
  voiceMediaClientUrl,
} from '../../types/clientMedia';
import { parseVoiceMediaWakePayload, waitForVoiceMediaWake } from './voiceMediaWakeStore';

const JSON_CONTENT_TYPE = 'application/json';
const MAX_HEARTBEAT_MS = 60_000;
const MAX_EVENT_EPOCH_LENGTH = 200;
const CONTROL_REQUEST_DEADLINE_MS = 8_000;
const REALTIME_NEGOTIATION_DEADLINE_MS = 20_000;

interface PushConnection {
  eventEpoch: string;
  heartbeatMs: number;
}

function pushConnection(result: VoiceMediaConnectResult): PushConnection | undefined {
  return typeof result.eventEpoch === 'string' &&
    result.eventEpoch.length > 0 &&
    result.eventEpoch.length <= MAX_EVENT_EPOCH_LENGTH &&
    Number.isSafeInteger(result.heartbeatMs) &&
    (result.heartbeatMs ?? 0) > 0 &&
    (result.heartbeatMs ?? 0) <= MAX_HEARTBEAT_MS
    ? { eventEpoch: result.eventEpoch, heartbeatMs: result.heartbeatMs as number }
    : undefined;
}

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

function cancelResponseBody(response: Response | undefined): void {
  try {
    void response?.body?.cancel().catch(() => undefined);
  } catch {
    // Injected transports may expose a nonstandard response body.
  }
}

async function boundedControlRequest<T>(
  input: string,
  init: RequestInit,
  deadlineMs: number,
  consume: (response: Response) => Promise<T> | T,
  parentSignal?: AbortSignal,
): Promise<T> {
  const deadlineController = new AbortController();
  const signal = parentSignal ?? deadlineController.signal;
  let response: Response | undefined;
  let cancelled = false;
  let cancellationReason: unknown;
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (reason: unknown): void => {
    if (cancelled) return;
    cancelled = true;
    cancellationReason = reason;
    deadlineController.abort(reason);
    cancelResponseBody(response);
    rejectCancellation(reason);
  };
  const abortParent = (): void =>
    cancel(parentSignal?.reason ?? new DOMException('Voice media control request was aborted.', 'AbortError'));
  const timer = setTimeout(() => cancel(new Error('Voice media control request timed out.')), deadlineMs);
  parentSignal?.addEventListener('abort', abortParent, { once: true });

  let fetched: Promise<Response>;
  try {
    fetched = sealedTransport.fetch(input, { ...init, signal });
  } catch (error) {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortParent);
    throw error;
  }
  const operation = fetched.then(async (result) => {
    response = result;
    if (cancelled) {
      cancelResponseBody(result);
      throw cancellationReason;
    }
    return consume(result);
  });

  try {
    if (parentSignal?.aborted) abortParent();
    return await Promise.race([operation, cancellation]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortParent);
  }
}

export class BrowserVoiceMediaTransport implements VoiceMediaTransport {
  private push: PushConnection | undefined;
  private controlLocation: 'local' | 'remote' | undefined;

  public constructor(private readonly sessionId: string) {}

  public async connect(
    clientId: string,
    connectionId: string,
    capabilities: VoiceMediaCapabilities,
  ): Promise<VoiceMediaConnectResult> {
    this.push = undefined;
    const controlLocation = sealedTransport.active() ? 'remote' : 'local';
    const response = await this.declareClient(clientId, connectionId, capabilities, controlLocation);
    if (!response.ok) throw await responseError(response);
    const connected = (await response.json()) as VoiceMediaConnectResult;
    this.controlLocation = controlLocation;
    this.push = pushConnection(connected);
    return connected;
  }

  public async refreshCapabilities(
    clientId: string,
    connectionId: string,
    capabilities: VoiceMediaCapabilities,
  ): Promise<void> {
    const controlLocation = this.controlLocation;
    if (controlLocation === undefined) throw new Error('Voice media client is not connected.');
    const response = await this.declareClient(clientId, connectionId, capabilities, controlLocation);
    if (!response.ok) throw await responseError(response);
  }

  public async disconnect(clientId: string, connectionId: string): Promise<void> {
    try {
      const response = await sealedTransport.fetch(
        voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientDisconnect),
        jsonBody({ clientId, connectionId }),
      );
      if (!response.ok && response.status !== 409) throw await responseError(response);
    } finally {
      this.push = undefined;
      this.controlLocation = undefined;
    }
  }

  public async nextEvent(
    clientId: string,
    connectionId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<VoiceMediaClientEvent | undefined> {
    const push = this.push;
    if (push === undefined) return this.fetchEvent(clientId, connectionId, after, signal, false);
    while (!signal.aborted) {
      const channelWake = await waitForVoiceMediaWake(this.sessionId, push.eventEpoch, after, push.heartbeatMs, signal);
      if (signal.aborted) return undefined;
      const wake = channelWake ?? (await this.heartbeat(clientId, connectionId));
      if (wake.eventEpoch !== push.eventEpoch) throw new Error('Voice media broker changed.');
      if (wake.sequence <= after) continue;
      const event = await this.fetchEvent(clientId, connectionId, after, signal, true);
      if (event === undefined) throw new Error('Voice media wake could not be resolved.');
      return event;
    }
    return undefined;
  }

  private declareClient(
    clientId: string,
    connectionId: string,
    capabilities: VoiceMediaCapabilities,
    controlLocation: 'local' | 'remote',
  ): Promise<Response> {
    return sealedTransport.fetch(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientConnect),
      jsonBody({
        version: VOICE_MEDIA_PROTOCOL_VERSION,
        clientId,
        connectionId,
        clientKind: 'browser',
        controlLocation,
        capabilities,
      }),
    );
  }

  private async fetchEvent(
    clientId: string,
    connectionId: string,
    after: number,
    signal: AbortSignal,
    nonblocking: boolean,
  ): Promise<VoiceMediaClientEvent | undefined> {
    return boundedControlRequest(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientEvents, {
        clientId,
        connectionId,
        after: String(after),
        ...(nonblocking ? { wait: VOICE_MEDIA_EVENT_WAIT_NONE } : {}),
      }),
      {},
      CONTROL_REQUEST_DEADLINE_MS,
      async (response) => {
        if (response.status === 204) return undefined;
        if (!response.ok) throw await responseError(response);
        return (await response.json()) as VoiceMediaClientEvent;
      },
      signal,
    );
  }

  private heartbeat(clientId: string, connectionId: string): Promise<VoiceMediaWake> {
    return boundedControlRequest(
      voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientHeartbeat),
      jsonBody({ clientId, connectionId }),
      CONTROL_REQUEST_DEADLINE_MS,
      async (response) => {
        if (!response.ok) throw await responseError(response);
        const wake = parseVoiceMediaWakePayload(await response.json());
        if (wake === null) throw new Error('Voice media heartbeat response is invalid.');
        return wake;
      },
    );
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
                ...(activity.echoDiscriminatedSpeechMs === undefined
                  ? {}
                  : {
                      [VOICE_MEDIA_ACTIVITY_ECHO_SPEECH_MS_HEADER]: String(activity.echoDiscriminatedSpeechMs),
                    }),
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

  public async receivePlaybackAudio(
    clientId: string,
    connectionId: string,
    playbackId: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (!signal.aborted) {
      const response = await sealedTransport.fetch(
        voiceMediaClientUrl(this.sessionId, VOICE_MEDIA_ROUTES.clientPlaybackAudio, {
          clientId,
          connectionId,
          playbackId,
        }),
        { signal },
      );
      if (response.status === 200 && response.headers.get('content-type')?.startsWith(VOICE_MEDIA_CONTENT_TYPE)) {
        const chunk = new Uint8Array(await response.arrayBuffer());
        chunks.push(chunk);
        byteLength += chunk.byteLength;
        continue;
      }
      if (response.status === 204 && response.headers.get(VOICE_MEDIA_PLAYBACK_STATE_HEADER) === 'sealed') {
        const pcm = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          pcm.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return pcm;
      }
      if (response.status === 204) continue;
      throw await responseError(response);
    }
    throw new DOMException('Voice playback audio was aborted.', 'AbortError');
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

  public async realtimeNegotiate(
    clientId: string,
    connectionId: string,
    activationId: string,
    sdp: string,
    signal: AbortSignal,
  ): Promise<string> {
    return boundedControlRequest(
      voiceMediaClientUrl(this.sessionId, REALTIME_ROUTES.clientNegotiate),
      jsonBody({ clientId, connectionId, activationId, sdp }),
      REALTIME_NEGOTIATION_DEADLINE_MS,
      async (response) => {
        if (!response.ok) throw await responseError(response);
        const body: unknown = await response.json();
        if (typeof body !== 'object' || body === null || typeof (body as { sdp?: unknown }).sdp !== 'string')
          throw new Error('Realtime negotiation response is invalid.');
        return (body as { sdp: string }).sdp;
      },
      signal,
    );
  }

  public async realtimeEvent(
    clientId: string,
    connectionId: string,
    activationId: string,
    event: string,
  ): Promise<void> {
    await this.postRealtime(REALTIME_ROUTES.clientEvent, { clientId, connectionId, activationId, event });
  }

  public async realtimeState(
    clientId: string,
    connectionId: string,
    activationId: string,
    state: RealtimeBrowserState,
  ): Promise<void> {
    await this.postRealtime(REALTIME_ROUTES.clientState, { clientId, connectionId, activationId, state });
  }

  private postRealtime(route: string, body: object): Promise<void> {
    return boundedControlRequest(
      voiceMediaClientUrl(this.sessionId, route),
      jsonBody(body),
      CONTROL_REQUEST_DEADLINE_MS,
      async (response) => {
        if (!response.ok) throw await responseError(response);
      },
    );
  }
}
