import type { WebPluginRuntime, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { Store } from '@tanstack/store';
import { useEffect } from 'react';
import { VOICE_MEDIA_WAKE_TYPE } from '../src/types/clientMedia.ts';
import { VOICE_OWNERSHIP_PROTOCOL_VERSION, type BrowserVoiceOwnershipPayload } from '../src/types/voiceOwnership.ts';
import { browserVoiceMediaClientId } from './browserMediaIdentity.ts';
import { BrowserVoiceMediaDevice } from './browserMediaDevice.ts';
import { BrowserVoiceMediaTransport } from './clientMediaTransport.ts';
import { VoiceMediaClient } from './voiceMediaClient.ts';
import { voiceOwnershipCommands } from './voiceMediaWakeStore.ts';
import { VoiceOwnershipCursor } from './voiceOwnershipCursor.ts';

const BROWSER_RUNTIME_ANNOUNCE_MS = 2_000;

class PageVoiceMediaRuntime {
  private readonly device = new BrowserVoiceMediaDevice(true);
  private readonly clientId = browserVoiceMediaClientId(window.sessionStorage, () => crypto.randomUUID());
  private readonly connectionId = `connection-${crypto.randomUUID()}`;
  private client: VoiceMediaClient | undefined;
  private readonly ownershipCursor = new VoiceOwnershipCursor(window.sessionStorage);
  private operation: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;

  public constructor(private readonly runtime: WebPluginRuntime) {
    const subscription = voiceOwnershipCommands.store.subscribe(() => this.acceptCommands());
    this.unsubscribe = () => subscription.unsubscribe();
  }

  public announce(sessionId: string): void {
    this.send(sessionId, { type: 'browser-media-runtime', version: VOICE_OWNERSHIP_PROTOCOL_VERSION });
  }

  public close(): void {
    this.unsubscribe();
    void this.operation.finally(async () => {
      await this.client?.stop(false);
      await this.device.close();
    });
  }

  private acceptCommands(): void {
    for (const [sessionId, command] of Object.entries(voiceOwnershipCommands.store.state)) {
      if (command === undefined) continue;
      if (!this.ownershipCursor.accept(command)) {
        voiceOwnershipCommands.drop(sessionId);
        this.ack(sessionId, command, false, undefined, 'Stale browser media command.');
        continue;
      }
      voiceOwnershipCommands.drop(sessionId);
      this.operation = this.operation.then(() => this.handle(sessionId, command));
    }
  }

  private async handle(
    sessionId: string,
    command: Extract<BrowserVoiceOwnershipPayload, { type: 'browser-media-command' }>,
  ): Promise<void> {
    try {
      if (command.action === 'detach') {
        await this.client?.stop(false);
        this.client = undefined;
      } else if (command.action === 'attach') {
        await this.client?.stop(false);
        const client = new VoiceMediaClient(
          this.clientId,
          this.connectionId,
          new BrowserVoiceMediaTransport(sessionId),
          this.device,
        );
        this.client = client;
        client.start();
      } else if (!(await this.client?.waitForListening())) {
        throw new Error('Fresh browser capture is not listening.');
      }
      this.ack(sessionId, command, true, command.action === 'ready' ? true : undefined);
    } catch (error) {
      this.ack(sessionId, command, false, undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private ack(
    sessionId: string,
    command: Extract<BrowserVoiceOwnershipPayload, { type: 'browser-media-command' }>,
    ok: boolean,
    listening?: boolean,
    error?: string,
  ): void {
    this.send(sessionId, {
      type: 'browser-media-ack',
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      epoch: command.epoch,
      generation: command.generation,
      revision: command.revision,
      action: command.action,
      ok,
      ...(listening === undefined ? {} : { listening }),
      ...(error === undefined ? {} : { error: error.slice(0, 300) }),
    });
  }

  private send(sessionId: string, payload: BrowserVoiceOwnershipPayload): void {
    this.runtime.sendHubFrame({ type: VOICE_MEDIA_WAKE_TYPE, sessionId, payload });
  }
}

const pageRuntime = new Store<PageVoiceMediaRuntime | undefined>(undefined);

export function startVoiceMediaRuntime(runtime: WebPluginRuntime): () => void {
  const instance = new PageVoiceMediaRuntime(runtime);
  pageRuntime.setState(() => instance);
  return () => {
    if (pageRuntime.state === instance) pageRuntime.setState(() => undefined);
    instance.close();
  };
}

export function VoiceMediaRuntime({ sessionId }: WebPluginSlotProps) {
  useEffect(() => {
    if (sessionId === null) return;
    const announce = (): void => pageRuntime.state?.announce(sessionId);
    announce();
    const timer = window.setInterval(announce, BROWSER_RUNTIME_ANNOUNCE_MS);
    return () => window.clearInterval(timer);
  }, [sessionId]);
  return null;
}
