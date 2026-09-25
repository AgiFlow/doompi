import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';

import { voice } from '../../../../../../../generated/client';
import type { VoiceMediaDevice } from '../../../../../../types/clientMedia';
import type { RealtimeBrowserState } from '../../../../../../types/realtime';
import {
  activeVoiceSession,
  voiceMediaBrowserState,
  voiceMediaHandoff,
  voiceMediaPageRuntime,
  voiceRealtimeBrowserControls,
} from '../../_lib/voiceMediaWakeStore';
import { closeVoiceMicrophoneQuestion, voiceMicrophoneConstraints } from '../../_lib/voiceMicrophoneStore';
import { BrowserVoiceMediaDevice } from '../_lib/browserMediaDevice';
import { browserVoiceMediaClientId } from '../_lib/browserMediaIdentity';
import { BrowserRealtimeSession } from '../_lib/browserRealtimeSession';
import { BrowserVoiceMediaTransport } from '../_lib/clientMediaTransport';
import { VoiceMediaClient, type VoiceMediaClientConnectionState } from '../_lib/voiceMediaClient';

class PageVoiceMediaRuntime {
  private readonly device = new BrowserVoiceMediaDevice(true, voiceMicrophoneConstraints);
  private readonly clientId = browserVoiceMediaClientId(window.sessionStorage, () => crypto.randomUUID());
  private readonly connectionId = `connection-${crypto.randomUUID()}`;
  private ownedSessionId: string | null = null;
  private handoffActive = false;
  private releaseAudioPending = false;
  private selectionGeneration = 0;
  private focusedSessionId: string | undefined;
  private client: VoiceMediaClient | undefined;
  private globalClient: VoiceMediaClient | undefined;
  private boundSessionId: string | undefined;
  private operation: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private readonly closeOnPageHide = (): void => this.close();
  private closed = false;

  public constructor() {
    // Ownership arrives after the command round trip. Arm now so the tap that
    // requested voice can unlock Web Audio on mobile Safari before that reply.
    this.device.armUserGesture();
    const selection = (): void => this.select(activeVoiceSession.store.state);
    const ownership = activeVoiceSession.store.subscribe(selection);
    const handoff = voiceMediaHandoff.store.subscribe(selection);
    this.unsubscribe = () => {
      ownership.unsubscribe();
      handoff.unsubscribe();
    };
    window.addEventListener('pagehide', this.closeOnPageHide, { once: true });
    void this.startGlobalClient();
    this.select(activeVoiceSession.store.state);
  }

  public focus(sessionId: string): void {
    this.focusedSessionId = sessionId;
    if (activeVoiceSession.store.state === null && voiceMediaHandoff.store.state === undefined) this.select(sessionId);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    // An open device question would otherwise outlive the capture that asked it.
    closeVoiceMicrophoneQuestion();
    window.removeEventListener('pagehide', this.closeOnPageHide);
    this.unsubscribe();
    this.client?.endRealtime();
    this.globalClient?.endRealtime();
    const dispose = async (): Promise<void> => {
      try {
        await this.detach();
        await this.globalClient?.stop(false);
        this.globalClient = undefined;
      } finally {
        await this.device.close();
      }
    };
    this.operation = this.operation.then(dispose, dispose).then(
      () => undefined,
      () => undefined,
    );
  }

  /** Global browser lease and WebRTC peer outlive every agent route and session focus change. */
  private async startGlobalClient(): Promise<void> {
    try {
      const status = await voice.global.liveStatus();
      if (this.closed) return;
      if (!status.ok || status.data.version !== 1) throw new Error('The host does not support global live Voice.');
      const device: VoiceMediaDevice = {
        capabilities: {
          capture: false,
          playback: false,
          captureActivity: false,
          autonomousOrchestration: false,
          realtime: true,
        },
        async startCapture() {
          throw new Error('Global live Voice does not accept PCM capture.');
        },
        speak() {
          throw new Error('Global live Voice does not accept PCM playback.');
        },
        async close() {},
      };
      let client!: VoiceMediaClient;
      const onConnection = (phase: VoiceMediaClientConnectionState): void => {
        if (this.globalClient !== client) return;
        const current = voiceMediaBrowserState.store.state;
        if (current?.sessionId !== null) return;
        if (phase === 'disconnected' && current.realtime?.connection !== 'failed') {
          voiceMediaBrowserState.reset();
          return;
        }
        if (phase !== 'disconnected') voiceMediaBrowserState.update(() => ({ ...current, phase }));
      };
      const onRealtime = (realtime: RealtimeBrowserState | undefined): void => {
        if (this.globalClient !== client) return;
        if (realtime === undefined) {
          if (voiceMediaBrowserState.store.state?.sessionId === null) voiceMediaBrowserState.reset();
          if (voiceRealtimeBrowserControls.store.state?.sessionId === null) voiceRealtimeBrowserControls.reset();
          return;
        }
        const current = voiceMediaBrowserState.store.state;
        voiceMediaBrowserState.update(() => ({
          sessionId: null,
          phase: current?.sessionId === null ? current.phase : 'connected',
          realtime,
          realtimeOutputInterrupted: current?.sessionId === null ? current.realtimeOutputInterrupted : undefined,
        }));
        voiceRealtimeBrowserControls.update(() => ({
          sessionId: null,
          mute: (muted) => this.controlGlobal(muted ? 'mute' : 'unmute'),
          interrupt: () => {
            client.interruptRealtime();
            this.controlGlobal('interrupt');
            const state = voiceMediaBrowserState.store.state;
            if (state?.sessionId === null)
              voiceMediaBrowserState.update(() => ({ ...state, realtimeOutputInterrupted: true }));
          },
          end: () => {
            client.endRealtime();
            this.controlGlobal('end');
          },
        }));
      };
      client = new VoiceMediaClient(
        this.clientId,
        this.connectionId,
        new BrowserVoiceMediaTransport(null),
        device,
        onConnection,
        onRealtime,
        (options) => new BrowserRealtimeSession(options, voiceMicrophoneConstraints),
      );
      this.globalClient = client;
      client.start();
    } catch (error) {
      if (this.closed || voiceMediaBrowserState.store.state?.sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      voiceMediaBrowserState.update(() => ({
        sessionId: null,
        phase: 'conflict',
        realtime: { connection: 'failed', listening: false, speaking: false, muted: false, error: message },
      }));
    }
  }

  private controlGlobal(action: 'mute' | 'unmute' | 'interrupt' | 'end'): void {
    void voice.global
      .liveControl({ body: { action } })
      .then((result) => {
        if (!result.ok) throw new Error(result.error);
      })
      .catch((error: unknown) => {
        const state = voiceMediaBrowserState.store.state;
        if (state !== undefined && state.sessionId !== null) return;
        voiceMediaBrowserState.update(() => ({
          sessionId: null,
          phase: 'conflict',
          realtime: {
            connection: 'failed',
            listening: false,
            speaking: false,
            muted: false,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      });
  }

  private select(sessionId: string | null): void {
    const handoff = voiceMediaHandoff.store.state;
    const owner = activeVoiceSession.store.state;
    this.releaseAudioPending ||=
      (this.ownedSessionId !== null || this.handoffActive) && owner === null && handoff === undefined;
    this.ownedSessionId = owner;
    this.handoffActive = handoff !== undefined;
    const generation = ++this.selectionGeneration;
    sessionId ??=
      (handoff?.phase === 'rebinding' ? handoff.targetSessionId : undefined) ??
      handoff?.sourceSessionId ??
      this.focusedSessionId ??
      null;
    if (sessionId !== this.boundSessionId && handoff === undefined) this.client?.endRealtime();
    const switchSession = async (): Promise<void> => {
      if (this.closed || generation !== this.selectionGeneration) return;
      if (this.releaseAudioPending) {
        await this.detach();
        await this.device.close();
        this.releaseAudioPending = false;
      }
      if (this.closed || generation !== this.selectionGeneration) return;
      if (sessionId === null) await this.detach();
      else await this.attach(sessionId, generation);
    };
    this.operation = this.operation.then(switchSession, switchSession).then(
      () => undefined,
      () => undefined,
    );
  }

  private async attach(sessionId: string, generation: number): Promise<void> {
    if (this.client !== undefined && this.boundSessionId === sessionId) return;
    await this.detach();
    if (this.closed || generation !== this.selectionGeneration) return;
    let client!: VoiceMediaClient;
    const reportConnectionState = (phase: VoiceMediaClientConnectionState): void => {
      if (this.client !== client || this.boundSessionId !== sessionId) return;
      if (phase === 'disconnected') {
        const current = voiceMediaBrowserState.store.state;
        if (current?.sessionId === sessionId) voiceMediaBrowserState.reset();
        return;
      }
      voiceMediaBrowserState.update((current) =>
        current?.sessionId === null && current.realtime !== undefined && current.realtime.connection !== 'failed'
          ? current
          : current?.sessionId === sessionId
            ? { ...current, phase }
            : { sessionId, phase },
      );
    };
    const reportRealtimeState = (realtime: RealtimeBrowserState | undefined): void => {
      if (this.client !== client || this.boundSessionId !== sessionId) return;
      const current = voiceMediaBrowserState.store.state;
      if (current?.sessionId !== sessionId) return;
      voiceMediaBrowserState.update(() => ({
        ...current,
        ...(realtime === undefined ? {} : { realtime }),
        ...(realtime === undefined ? { realtime: undefined, realtimeOutputInterrupted: undefined } : {}),
      }));
    };
    client = new VoiceMediaClient(
      this.clientId,
      this.connectionId,
      new BrowserVoiceMediaTransport(sessionId),
      this.device,
      reportConnectionState,
      reportRealtimeState,
      (options) => new BrowserRealtimeSession(options, voiceMicrophoneConstraints),
    );
    this.client = client;
    this.boundSessionId = sessionId;
    if (voiceRealtimeBrowserControls.store.state?.sessionId !== null)
      voiceRealtimeBrowserControls.update(() => ({
        sessionId,
        mute: (muted) => client.muteRealtime(muted),
        interrupt: () => {
          client.interruptRealtime();
          const current = voiceMediaBrowserState.store.state;
          if (current?.sessionId === sessionId)
            voiceMediaBrowserState.update(() => ({ ...current, realtimeOutputInterrupted: true }));
        },
        end: () => client.endRealtime(),
      }));
    client.start();
  }

  private async detach(): Promise<void> {
    const client = this.client;
    const sessionId = this.boundSessionId;
    this.client = undefined;
    this.boundSessionId = undefined;
    if (sessionId !== undefined && voiceMediaBrowserState.store.state?.sessionId === sessionId)
      voiceMediaBrowserState.reset();
    if (sessionId !== undefined && voiceRealtimeBrowserControls.store.state?.sessionId === sessionId)
      voiceRealtimeBrowserControls.reset();
    await client?.stop(false);
  }
}

export function startVoiceMediaRuntime(runtime: WebPluginRuntime): () => void {
  let instance = voiceMediaPageRuntime.store.state as PageVoiceMediaRuntime | undefined;
  if (instance === undefined) {
    instance = new PageVoiceMediaRuntime();
    voiceMediaPageRuntime.update(() => instance);
  }
  if (runtime.mount?.scope === 'session') instance.focus(runtime.mount.sessionId);
  // Session plugin compositions are route-scoped, but microphone ownership is page-scoped.
  // The pagehide listener owns real cleanup so focus changes cannot disconnect active capture.
  return () => undefined;
}
