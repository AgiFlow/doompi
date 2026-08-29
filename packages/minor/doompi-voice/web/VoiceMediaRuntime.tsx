import type { WebPluginRuntime } from '@agimon-ai/doompi-web-contracts';
import { browserVoiceMediaClientId } from './browserMediaIdentity.ts';
import { BrowserVoiceMediaDevice } from './browserMediaDevice.ts';
import { BrowserVoiceMediaTransport } from './clientMediaTransport.ts';
import { VoiceMediaClient, type VoiceMediaClientConnectionState } from './voiceMediaClient.ts';
import { activeVoiceSession, voiceMediaBrowserState } from './voiceMediaWakeStore.ts';

class PageVoiceMediaRuntime {
  private readonly device = new BrowserVoiceMediaDevice(true);
  private readonly clientId = browserVoiceMediaClientId(window.sessionStorage, () => crypto.randomUUID());
  private readonly connectionId = `connection-${crypto.randomUUID()}`;
  private client: VoiceMediaClient | undefined;
  private boundSessionId: string | undefined;
  private operation: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private closed = false;

  public constructor() {
    const subscription = activeVoiceSession.store.subscribe(() => this.select(activeVoiceSession.store.state));
    this.unsubscribe = () => subscription.unsubscribe();
    this.select(activeVoiceSession.store.state);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
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
      voiceMediaBrowserState.update(() => ({ sessionId, phase }));
    };
    client = new VoiceMediaClient(
      this.clientId,
      this.connectionId,
      new BrowserVoiceMediaTransport(sessionId),
      this.device,
      reportConnectionState,
    );
    this.client = client;
    this.boundSessionId = sessionId;
    client.start();
  }

  private async detach(): Promise<void> {
    const client = this.client;
    const sessionId = this.boundSessionId;
    this.client = undefined;
    this.boundSessionId = undefined;
    if (sessionId !== undefined && voiceMediaBrowserState.store.state?.sessionId === sessionId)
      voiceMediaBrowserState.reset();
    await client?.stop(false);
  }
}

export function startVoiceMediaRuntime(_runtime: WebPluginRuntime): () => void {
  const instance = new PageVoiceMediaRuntime();
  return () => {
    instance.close();
    activeVoiceSession.reset();
    voiceMediaBrowserState.reset();
  };
}
