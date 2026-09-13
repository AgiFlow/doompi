import { defineGlobalStore, type GlobalStore } from '@agimon-ai/doompi-core/web';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

import type { VoiceMicrophoneConstraints } from '../../types/clientMedia';

interface PreferenceMediaStream {
  getTracks(): Array<{ stop(): void }>;
}
const browser = globalThis as unknown as {
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  navigator: {
    mediaDevices: {
      enumerateDevices(): Promise<Array<AudioInput & { kind: string }>>;
      getUserMedia(constraints: VoiceMicrophoneConstraints): Promise<PreferenceMediaStream>;
      addEventListener(event: 'devicechange', listener: () => void): void;
      removeEventListener(event: 'devicechange', listener: () => void): void;
    };
  };
};
export function watchVoiceMicrophones(listener: () => void): () => void {
  browser.navigator.mediaDevices?.addEventListener('devicechange', listener);
  return () => browser.navigator.mediaDevices?.removeEventListener('devicechange', listener);
}
interface AudioInput {
  deviceId: string;
  groupId: string;
  label: string;
}
interface MicrophoneState {
  inputs: AudioInput[];
  deviceId: string | null;
  error?: string;
  busy: boolean;
}
const key = Symbol.for('@agimon-ai/doompi-voice:microphone-preferences.v1');
const page = globalThis as unknown as Record<symbol, unknown>;
export const voiceMicrophone = (page[key] ??= defineGlobalStore<MicrophoneState>({
  inputs: [],
  deviceId: null,
  busy: false,
})) as GlobalStore<MicrophoneState>;

function clientUrl(): string {
  const key = 'doompi.voice.preferences-client-id';
  let id = browser.localStorage.getItem(key);
  if (!id) {
    id = `browser-${crypto.randomUUID()}`;
    browser.localStorage.setItem(key, id);
  }
  return `/api/global/plugin/voice/clients/${encodeURIComponent(id)}`;
}

async function request(path: string, init?: RequestInit): Promise<Pick<MicrophoneState, 'inputs' | 'deviceId'>> {
  const response = await sealedTransport.fetch(path, init);
  const result = (await response.json()) as Pick<MicrophoneState, 'inputs' | 'deviceId'> & { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'Microphone settings could not be saved.');
  return result;
}

export function physicalDefaultInput(inputs: readonly AudioInput[]): AudioInput | undefined {
  const alias = inputs.find((input) => input.deviceId === 'default');
  if (!alias?.groupId) return undefined;
  const matches = inputs.filter(
    (input) => input.deviceId !== 'default' && input.deviceId !== 'communications' && input.groupId === alias.groupId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export async function refreshVoiceMicrophones(): Promise<void> {
  voiceMicrophone.update((state) => ({ ...state, busy: true, error: undefined }));
  try {
    const devices = await browser.navigator.mediaDevices.enumerateDevices();
    const all = devices.filter((input) => input.kind === 'audioinput');
    const inputs = all
      .filter((input) => input.deviceId && input.deviceId !== 'default' && input.deviceId !== 'communications')
      .map(({ deviceId, groupId, label }) => ({ deviceId, groupId, label }));
    const saved = await request(`${clientUrl()}/inputs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs }),
    });
    voiceMicrophone.update(() => ({ ...saved, busy: false }));
    if (!saved.deviceId) {
      const selected = physicalDefaultInput(all);
      if (selected) await selectVoiceMicrophone(selected.deviceId);
    }
  } catch (error) {
    voiceMicrophone.update((state) => ({
      ...state,
      busy: false,
      error: error instanceof Error ? error.message : 'Microphone discovery failed.',
    }));
    throw error;
  }
}

export async function selectVoiceMicrophone(deviceId: string | null): Promise<void> {
  const saved = await request(clientUrl(), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  voiceMicrophone.update(() => ({ ...saved, busy: false }));
}

/** Resolve the physical input before opening a recording, never record the default alias. */
export async function voiceMicrophoneConstraints(): Promise<VoiceMicrophoneConstraints> {
  let permissionStream: PreferenceMediaStream | undefined;
  try {
    const devices = await browser.navigator.mediaDevices.enumerateDevices();
    if (!devices.some((input) => input.kind === 'audioinput' && input.label))
      permissionStream = await browser.navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    await refreshVoiceMicrophones();
    const { inputs, deviceId } = voiceMicrophone.store.state;
    if (!deviceId) throw new Error('Choose a microphone beside the voice button.');
    if (!inputs.some((input) => input.deviceId === deviceId))
      throw new Error('The selected microphone is unavailable. Choose another microphone.');
    return {
      audio: {
        deviceId: { exact: deviceId },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    };
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }
}

export async function discoverVoiceMicrophones(): Promise<void> {
  const stream = await browser.navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  try {
    await refreshVoiceMicrophones();
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}
