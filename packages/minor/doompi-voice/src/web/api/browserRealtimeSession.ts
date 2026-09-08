import { REALTIME_LIMITS, type BrowserRealtimeOptions, type RealtimeBrowserState } from '../../types/realtime.ts';

interface BrowserMediaTrack {
  readonly kind: string;
  enabled: boolean;
  onended: (() => void) | null;
  stop(): void;
}

interface BrowserMediaStream {
  getTracks(): BrowserMediaTrack[];
  getAudioTracks(): BrowserMediaTrack[];
}

interface BrowserAudio {
  autoplay: boolean;
  muted: boolean;
  srcObject: BrowserMediaStream | null;
  onplaying: (() => void) | null;
  onpause: (() => void) | null;
  onended: (() => void) | null;
  onwaiting: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

interface BrowserDataChannel extends EventTarget {
  readonly readyState: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(event: string): void;
  close(): void;
}

interface BrowserPeerConnection extends EventTarget {
  readonly connectionState: string;
  readonly iceGatheringState: string;
  readonly localDescription: { sdp?: string } | null;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((event: BrowserTrackEvent) => void) | null;
  createDataChannel(label: string): BrowserDataChannel;
  addTrack(track: BrowserMediaTrack, stream: BrowserMediaStream): void;
  createOffer(): Promise<{ sdp?: string }>;
  setLocalDescription(description: { sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<void>;
  close(): void;
}

interface BrowserTrackEvent {
  readonly track: BrowserMediaTrack;
  readonly streams: BrowserMediaStream[];
}

const browser = globalThis as unknown as {
  navigator: {
    mediaDevices?: { getUserMedia(constraints: { audio: true; video: false }): Promise<BrowserMediaStream> };
  };
  RTCPeerConnection?: new () => BrowserPeerConnection;
  MediaStream: new (tracks: BrowserMediaTrack[]) => BrowserMediaStream;
  document: { createElement(tag: 'audio'): BrowserAudio };
};

const ICE_TIMEOUT_MS = 10_000;
const CONNECTION_TIMEOUT_MS = 15_000;
const NEGOTIATION_TIMEOUT_MS = 15_000;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function messageType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Owns one browser WebRTC microphone and remote audio sink.
 *
 * interruptSpeech only suppresses local output and preserves microphone input.
 * Frameless bidi has no event that safely distinguishes a new response from
 * buffered audio belonging to the interrupted turn, so output remains muted
 * for this session rather than being resumed automatically.
 */
export class BrowserRealtimeSession {
  private state: RealtimeBrowserState = {
    connection: 'closed',
    listening: false,
    speaking: false,
    muted: false,
  };
  private generation = 0;
  private started = false;
  private stream: BrowserMediaStream | undefined;
  private peer: BrowserPeerConnection | undefined;
  private channel: BrowserDataChannel | undefined;
  private audio: BrowserAudio | undefined;
  private abortController: AbortController | undefined;
  private suppressOutput = false;

  public constructor(private readonly options: BrowserRealtimeOptions) {}

  public async start(): Promise<void> {
    if (this.started) throw new Error('Realtime browser session has already started.');
    this.started = true;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    this.publish({ connection: 'connecting', error: undefined });

    try {
      if (typeof browser.RTCPeerConnection !== 'function' || browser.navigator.mediaDevices?.getUserMedia === undefined)
        throw new Error('Browser realtime media is unavailable.');

      const capture = browser.navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      void capture.then(
        (lateStream) => {
          if (!this.isCurrent(generation)) for (const track of lateStream.getTracks()) track.stop();
        },
        () => undefined,
      );
      const stream = await this.abortable(capture, controller.signal);
      if (!this.isCurrent(generation)) {
        for (const track of stream.getTracks()) track.stop();
        throw new Error('Realtime browser session was closed.');
      }
      this.stream = stream;
      for (const track of stream.getTracks()) {
        if (track.kind === 'audio') track.enabled = !this.state.muted;
        track.onended = () => this.fail(generation, 'Microphone permission or input was lost.');
      }

      const peer = new browser.RTCPeerConnection();
      this.peer = peer;
      peer.onconnectionstatechange = () => {
        if (!this.isCurrent(generation)) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected')
          this.fail(generation, `Realtime connection ${peer.connectionState}.`);
        else if (peer.connectionState === 'closed' && this.state.connection !== 'closed')
          this.fail(generation, 'Realtime connection closed unexpectedly.');
      };
      peer.ontrack = (event) => this.attachRemoteAudio(generation, event);

      // OpenAI requires the oai-events data channel to be present in the offer.
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.onmessage = (event) => this.receive(generation, event.data);
      channel.onerror = () => this.fail(generation, 'Realtime event channel failed.');
      channel.onclose = () => {
        if (this.isCurrent(generation)) this.fail(generation, 'Realtime event channel closed unexpectedly.');
      };

      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      const offer = await peer.createOffer();
      this.assertSdp(offer.sdp);
      await peer.setLocalDescription(offer);
      await this.waitForIce(peer, generation, controller.signal);
      const localSdp = peer.localDescription?.sdp;
      this.assertSdp(localSdp);
      const answerSdp = await this.bounded(
        this.options.negotiate(localSdp, controller.signal),
        NEGOTIATION_TIMEOUT_MS,
        'Realtime negotiation timed out.',
        controller.signal,
      );
      this.assertSdp(answerSdp);
      if (!this.isCurrent(generation)) throw new Error('Realtime browser session was closed.');
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      await this.waitForConnection(peer, channel, generation, controller.signal);
      if (!this.isCurrent(generation)) throw new Error('Realtime browser session was closed.');
      this.publish({ connection: 'connected', listening: !this.state.muted });
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(generation, errorMessage(error));
      throw error;
    }
  }

  public send(event: string): void {
    this.validateEvent(event);
    if (this.channel?.readyState !== 'open' || this.state.connection !== 'connected')
      throw new Error('Realtime event channel is not open.');
    this.channel.send(event);
  }

  public mute(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.publish({ muted, listening: this.state.connection === 'connected' && !muted });
  }

  public interruptSpeech(): void {
    this.suppressOutput = true;
    if (this.audio !== undefined) this.audio.muted = true;
    this.publish({ speaking: false });
  }

  public close(): void {
    if (this.state.connection === 'closed' && this.generation > 0) return;
    this.started = true;
    this.generation += 1;
    this.cleanup();
    this.publish({ connection: 'closed', listening: false, speaking: false, error: undefined });
  }

  private receive(generation: number, data: unknown): void {
    if (!this.isCurrent(generation)) return;
    if (typeof data !== 'string' || byteLength(data) > REALTIME_LIMITS.eventBytes) {
      this.fail(generation, 'Realtime provider sent an invalid or oversized event.');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      this.fail(generation, 'Realtime provider sent malformed JSON.');
      return;
    }
    const type = messageType(value);
    if (type === undefined) {
      this.fail(generation, 'Realtime provider sent an event without a type.');
      return;
    }
    if (type === 'error') {
      this.fail(generation, 'Realtime provider reported an error.');
      return;
    }
    try {
      this.options.onEvent(data);
    } catch (error) {
      this.fail(generation, `Realtime event consumer failed: ${errorMessage(error)}`);
    }
  }

  private attachRemoteAudio(generation: number, event: BrowserTrackEvent): void {
    if (!this.isCurrent(generation) || event.track.kind !== 'audio') return;
    const audio = browser.document.createElement('audio');
    audio.autoplay = true;
    audio.muted = this.suppressOutput;
    audio.srcObject = event.streams[0] ?? new browser.MediaStream([event.track]);
    audio.onplaying = () => {
      if (this.isCurrent(generation) && !audio.muted) this.publish({ speaking: true });
    };
    const playbackStopped = (): void => {
      if (this.isCurrent(generation)) this.publish({ speaking: false });
    };
    audio.onpause = playbackStopped;
    audio.onended = playbackStopped;
    audio.onwaiting = playbackStopped;
    this.detachAudio();
    this.audio = audio;
    void audio
      .play()
      .catch((error: unknown) => this.fail(generation, `Remote audio playback failed: ${errorMessage(error)}`));
  }

  private validateEvent(event: string): void {
    if (byteLength(event) > REALTIME_LIMITS.eventBytes) throw new Error('Realtime event exceeds the maximum size.');
    let value: unknown;
    try {
      value = JSON.parse(event);
    } catch {
      throw new Error('Realtime event must be valid JSON.');
    }
    if (messageType(value) === undefined) throw new Error('Realtime event must contain a type.');
  }

  private assertSdp(sdp: string | undefined): asserts sdp is string {
    if (typeof sdp !== 'string' || sdp.length === 0) throw new Error('Realtime SDP is missing.');
    if (byteLength(sdp) > REALTIME_LIMITS.sdpBytes) throw new Error('Realtime SDP exceeds the maximum size.');
  }

  private async waitForIce(peer: BrowserPeerConnection, generation: number, signal: AbortSignal): Promise<void> {
    if (peer.iceGatheringState === 'complete') return;
    const changed = (): void => {
      if (!this.isCurrent(generation) || peer.iceGatheringState !== 'complete') return;
      resolveIce?.();
    };
    let resolveIce: (() => void) | undefined;
    try {
      await this.bounded(
        new Promise<void>((resolve) => {
          resolveIce = resolve;
          peer.addEventListener('icegatheringstatechange', changed);
          changed();
        }),
        ICE_TIMEOUT_MS,
        'Realtime ICE gathering timed out.',
        signal,
      );
    } finally {
      peer.removeEventListener('icegatheringstatechange', changed);
    }
  }

  private async waitForConnection(
    peer: BrowserPeerConnection,
    channel: BrowserDataChannel,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const ready = (): boolean => peer.connectionState === 'connected' && channel.readyState === 'open';
    if (ready()) return;
    const changed = (): void => {
      if (!this.isCurrent(generation)) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        rejectConnection?.(new Error(`Realtime connection ${peer.connectionState}.`));
        return;
      }
      if (ready()) resolveConnection?.();
    };
    let resolveConnection: (() => void) | undefined;
    let rejectConnection: ((error: Error) => void) | undefined;
    try {
      await this.bounded(
        new Promise<void>((resolve, reject) => {
          resolveConnection = resolve;
          rejectConnection = reject;
          peer.addEventListener('connectionstatechange', changed);
          channel.addEventListener('open', changed);
          channel.addEventListener('close', changed);
          changed();
        }),
        CONNECTION_TIMEOUT_MS,
        'Realtime connection timed out.',
        signal,
      );
    } finally {
      peer.removeEventListener('connectionstatechange', changed);
      channel.removeEventListener('open', changed);
      channel.removeEventListener('close', changed);
    }
  }

  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        callback();
      };
      const aborted = (): void => finish(() => reject(new Error('Realtime browser session was closed.')));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private bounded<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        callback();
      };
      const aborted = (): void => finish(() => reject(new Error('Realtime browser session was closed.')));
      const timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), timeoutMs);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private fail(generation: number, error: string): void {
    if (!this.isCurrent(generation)) return;
    this.generation += 1;
    this.cleanup();
    this.publish({ connection: 'failed', listening: false, speaking: false, error });
  }

  private cleanup(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.channel !== undefined) {
      this.channel.onmessage = null;
      this.channel.onerror = null;
      this.channel.onclose = null;
      this.channel.close();
    }
    if (this.peer !== undefined) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
    }
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.detachAudio();
    this.channel = undefined;
    this.peer = undefined;
    this.stream = undefined;
    this.suppressOutput = false;
  }

  private detachAudio(): void {
    if (this.audio === undefined) return;
    this.audio.onplaying = null;
    this.audio.onpause = null;
    this.audio.onended = null;
    this.audio.onwaiting = null;
    this.audio.pause();
    this.audio.srcObject = null;
    this.audio = undefined;
  }

  private publish(update: Partial<RealtimeBrowserState>): void {
    this.state = { ...this.state, ...update };
    try {
      this.options.onState({ ...this.state });
    } catch {
      // State observers do not own browser media cleanup or transport lifetime.
    }
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation;
  }
}
