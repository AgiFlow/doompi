import { defineGlobalStore, type GlobalStore } from '@agimon-ai/doompi-core/web';

import {
  CLIENT_DEFAULT_MICROPHONE,
  exactMicrophone,
  type VoiceMicrophoneConstraints,
} from '../../../../../types/clientMedia';

interface PreferenceMediaStream {
  getTracks(): Array<{ stop(): void }>;
}
const browser = globalThis as unknown as {
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  navigator: {
    mediaDevices: {
      enumerateDevices(): Promise<Array<AudioInput & { kind: string }>>;
      getUserMedia(constraints: VoiceMicrophoneConstraints): Promise<PreferenceMediaStream>;
    };
  };
};
interface AudioInput {
  deviceId: string;
  groupId: string;
  label: string;
}
interface MicrophoneState {
  inputs: AudioInput[];
  /** Set only while the dialog is open. Autonomous capture is parked on this. */
  choice?: (deviceId: string | null, remember: boolean) => void;
}
const key = Symbol.for('@agimon-ai/doompi-voice:microphone-preferences.v2');
const page = globalThis as unknown as Record<symbol, unknown>;
export const voiceMicrophone = (page[key] ??= defineGlobalStore<MicrophoneState>({
  inputs: [],
})) as GlobalStore<MicrophoneState>;

const CHOICE_KEY = 'doompi.voice.microphone.v1';

interface SavedChoice {
  /** null is a real answer: the user asked for the browser's own default. */
  deviceId: string | null;
  /** The inputs present when they answered. A different set earns a new question. */
  inputs: string[];
}

/** Local storage is user-writable, so a stored answer is parsed defensively. */
function readChoice(): SavedChoice | undefined {
  try {
    const raw = browser.localStorage.getItem(CHOICE_KEY);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const { deviceId, inputs } = value as Partial<SavedChoice>;
    if (deviceId !== null && typeof deviceId !== 'string') return undefined;
    if (!Array.isArray(inputs) || inputs.some((id) => typeof id !== 'string')) return undefined;
    return { deviceId, inputs };
  } catch {
    return undefined;
  }
}

function writeChoice(choice: SavedChoice): void {
  try {
    browser.localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
  } catch {
    // A full or blocked store costs the memory of the answer, not the session.
  }
}

/** Physical inputs only: the `default` and `communications` aliases duplicate a real device. */
export async function refreshVoiceMicrophones(): Promise<AudioInput[]> {
  const devices = await browser.navigator.mediaDevices.enumerateDevices();
  const inputs = devices
    .filter(
      (input) =>
        input.kind === 'audioinput' &&
        input.deviceId &&
        input.deviceId !== 'default' &&
        input.deviceId !== 'communications',
    )
    .map(({ deviceId, groupId, label }) => ({ deviceId, groupId, label }));
  voiceMicrophone.update((state) => ({ ...state, inputs }));
  return inputs;
}

function askVoiceMicrophone(): Promise<{ deviceId: string | null; remember: boolean }> {
  if (voiceMicrophone.store.state.choice !== undefined) return Promise.resolve({ deviceId: null, remember: false });
  return new Promise((resolve) => {
    voiceMicrophone.update((state) => ({
      ...state,
      choice: (deviceId, remember) => {
        voiceMicrophone.update((current) => ({ ...current, choice: undefined }));
        resolve({ deviceId, remember });
      },
    }));
  });
}

/** Resolves any pending question so deactivating voice does not orphan the dialog. */
export function closeVoiceMicrophoneQuestion(): void {
  voiceMicrophone.store.state.choice?.(null, false);
}

/**
 * The input one capture should open. One input or none needs no question, because the
 * browser already knows the answer; two or more with no matching saved answer is the
 * only case worth asking about.
 */
export async function voiceMicrophoneConstraints(): Promise<VoiceMicrophoneConstraints> {
  let permissionStream: PreferenceMediaStream | undefined;
  try {
    const devices = await browser.navigator.mediaDevices.enumerateDevices();
    if (!devices.some((input) => input.kind === 'audioinput' && input.label))
      permissionStream = await browser.navigator.mediaDevices.getUserMedia(CLIENT_DEFAULT_MICROPHONE);
    const inputs = await refreshVoiceMicrophones();
    if (inputs.length < 2) return CLIENT_DEFAULT_MICROPHONE;

    const present = inputs.map((input) => input.deviceId).sort();
    const saved = readChoice();
    if (saved !== undefined && saved.inputs.join() === present.join())
      return saved.deviceId === null ? CLIENT_DEFAULT_MICROPHONE : exactMicrophone(saved.deviceId);

    const { deviceId, remember } = await askVoiceMicrophone();
    if (remember) writeChoice({ deviceId, inputs: present });
    return deviceId === null ? CLIENT_DEFAULT_MICROPHONE : exactMicrophone(deviceId);
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }
}