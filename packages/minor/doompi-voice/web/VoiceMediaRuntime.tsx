import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect } from 'react';
import { browserVoiceMediaClientId } from './browserMediaIdentity.ts';
import { BrowserVoiceMediaDevice } from './browserMediaDevice.ts';
import { BrowserVoiceMediaTransport } from './clientMediaTransport.ts';
import { VoiceMediaClient } from './voiceMediaClient.ts';

export function VoiceMediaRuntime({ sessionId }: WebPluginSlotProps) {
  useEffect(() => {
    if (sessionId === null) return;
    const client = new VoiceMediaClient(
      browserVoiceMediaClientId(window.sessionStorage, () => crypto.randomUUID()),
      `connection-${crypto.randomUUID()}`,
      new BrowserVoiceMediaTransport(sessionId),
      new BrowserVoiceMediaDevice(),
    );
    client.start();
    return () => void client.stop();
  }, [sessionId]);

  return null;
}
