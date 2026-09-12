import type { WebPluginRuntime } from '@agimon-ai/doompi-core/web';
import type { RealtimeBrowserState } from '../../types/realtime';
import { browserVoiceMediaClientId } from '../lib/browserMediaIdentity';
import { BrowserVoiceMediaDevice } from '../api/browserMediaDevice';
import { BrowserVoiceMediaTransport } from '../stores/clientMediaTransport';
import { VoiceMediaClient, type VoiceMediaClientConnectionState } from '../api/voiceMediaClient';
import {
  activeVoiceSession,
  voiceMediaBrowserState,
  voiceMediaPageRuntime,
  voiceRealtimeBrowserControls,
} from '../stores/voiceMediaWakeStore';

class PageVoiceMediaRuntime {
  private readonly device = new BrowserVoiceMediaDevice(true);
  private readonly clientId = browserVoiceMediaClientId(window.sessionStorage, () => crypto.randomUUID());
  private readonly connectionId = `connection-${crypto.randomUUID()}`;
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

  public close(): void {
    if (this.closed) return;
    this.closed = true;
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
    if (sessionId !== this.boundSessionId) this.client?.endRealtime();
    const switchSession = async (): Promise<void> => {
      if (this.closed) return;
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

export function startVoiceMediaRuntime(_runtime: WebPluginRuntime): () => void {
  let instance = voiceMediaPageRuntime.store.state as PageVoiceMediaRuntime | undefined;
  if (instance === undefined) {
    instance = new PageVoiceMediaRuntime();
    voiceMediaPageRuntime.update(() => instance);
  }
  // Session plugin compositions are route-scoped, but microphone ownership is page-scoped.
  // The pagehide listener owns real cleanup so focus changes cannot disconnect active capture.
  return () => undefined;
}
