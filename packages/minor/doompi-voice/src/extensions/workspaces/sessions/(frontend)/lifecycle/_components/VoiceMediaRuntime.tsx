import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';

import type { RealtimeBrowserState } from '../../../../../../types/realtime';
import {
  activeVoiceSession,
  voiceMediaBrowserState,
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
  private focusedSessionId: string | undefined;
  private client: VoiceMediaClient | undefined;
  private boundSessionId: string | undefined;
  private operation: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private readonly closeOnPageHide = (): void => this.close();
  private closed = false;

  public constructor() {
    // Ownership arrives after the command round trip. Arm now so the tap that
    // requested voice can unlock Web Audio on mobile Safari before that reply.
    this.device.armUserGesture();
    const subscription = activeVoiceSession.store.subscribe(() => this.select(activeVoiceSession.store.state));
    this.unsubscribe = () => subscription.unsubscribe();
    window.addEventListener('pagehide', this.closeOnPageHide, { once: true });
    this.select(activeVoiceSession.store.state);
  }

  public focus(sessionId: string): void {
    this.focusedSessionId = sessionId;
    if (activeVoiceSession.store.state === null) this.select(sessionId);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    // An open device question would otherwise outlive the capture that asked it.
    closeVoiceMicrophoneQuestion();
    window.removeEventListener('pagehide', this.closeOnPageHide);
    this.unsubscribe();
    this.client?.endRealtime();
    const dispose = async (): Promise<void> => {
      try {
        await this.detach();
      } finally {
        await this.device.close();
      }
    };
    this.operation = this.operation.then(dispose, dispose).then(
      () => undefined,
      () => undefined,
    );
  }

  private select(sessionId: string | null): void {
    const releaseAudio = this.ownedSessionId !== null && activeVoiceSession.store.state === null;
    this.ownedSessionId = activeVoiceSession.store.state;
    sessionId ??= this.focusedSessionId ?? null;
    if (sessionId !== this.boundSessionId) this.client?.endRealtime();
    const switchSession = async (): Promise<void> => {
      if (this.closed) return;
      if (releaseAudio) {
        await this.detach();
        await this.device.close();
      }
      if (sessionId === null) await this.detach();
      else await this.attach(sessionId);
    };
    this.operation = this.operation.then(switchSession, switchSession).then(
      () => undefined,
      () => undefined,
    );
  }

  private async attach(sessionId: string): Promise<void> {
    if (this.client !== undefined && this.boundSessionId === sessionId) return;
    await this.detach();
    let client!: VoiceMediaClient;
    const reportConnectionState = (phase: VoiceMediaClientConnectionState): void => {
      if (this.client !== client || this.boundSessionId !== sessionId) return;
      if (phase === 'disconnected') {
        const current = voiceMediaBrowserState.store.state;
        if (current?.sessionId === sessionId) voiceMediaBrowserState.reset();
        return;
      }
      voiceMediaBrowserState.update((current) =>
        current?.sessionId === sessionId ? { ...current, phase } : { sessionId, phase },
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
