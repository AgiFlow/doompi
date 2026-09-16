import { afterEach, describe, expect, it, vi } from 'vitest';

import { voiceMicrophone, voiceMicrophoneConstraints } from '../src/extensions/workspaces/sessions/(frontend)/_lib/voiceMicrophoneStore';

const built = { deviceId: 'built-in', groupId: 'internal', label: 'MacBook microphone' };
const usb = { deviceId: 'usb', groupId: 'external', label: 'USB microphone' };

let store: Record<string, string>;

function stubBrowser(inputs: Array<typeof built>): void {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => inputs.map((input) => ({ ...input, kind: 'audioinput' })),
      getUserMedia: async () => ({ getTracks: () => [] }),
    },
  });
}

/**
 * Waits for the call to park on the dialog. A call that answers itself never sets
 * `choice`, so this throwing is the assertion that the question was asked at all.
 */
async function untilAsked(): Promise<(deviceId: string | null, remember: boolean) => void> {
  for (let tick = 0; tick < 50; tick += 1) {
    const choice = voiceMicrophone.store.state.choice;
    if (choice !== undefined) return choice;
    await Promise.resolve();
  }
  throw new Error('The microphone question was never asked.');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  voiceMicrophone.reset();
});

describe('browser microphone selection', () => {
  it('uses the client default when the browser reports one input', async () => {
    stubBrowser([built]);
    expect(await voiceMicrophoneConstraints()).toEqual({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    expect(voiceMicrophone.store.state.choice).toBeUndefined();
    expect(store['doompi.voice.microphone.v1']).toBeUndefined();
  });

  it('asks which input to open when several exist and no answer is saved', async () => {
    stubBrowser([built, usb]);
    const constraints = voiceMicrophoneConstraints();
    (await untilAsked())('usb', true);
    expect(await constraints).toEqual({
      audio: {
        deviceId: { exact: 'usb' },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    expect(voiceMicrophone.store.state.choice).toBeUndefined();
  });

  it('does not ask again until the set of inputs changes', async () => {
    stubBrowser([built, usb]);
    const first = voiceMicrophoneConstraints();
    (await untilAsked())('usb', true);
    await first;

    expect(await voiceMicrophoneConstraints()).toMatchObject({ audio: { deviceId: { exact: 'usb' } } });
    expect(voiceMicrophone.store.state.choice).toBeUndefined();

    stubBrowser([built, usb, { deviceId: 'headset', groupId: 'bt', label: 'Headset' }]);
    const third = voiceMicrophoneConstraints();
    (await untilAsked())('headset', true);
    expect(await third).toMatchObject({ audio: { deviceId: { exact: 'headset' } } });
  });

  it('takes escape as the browser default for one activation only', async () => {
    stubBrowser([built, usb]);
    const dismissed = voiceMicrophoneConstraints();
    (await untilAsked())(null, false);
    expect((await dismissed).audio.deviceId).toBeUndefined();
    expect(store['doompi.voice.microphone.v1']).toBeUndefined();

    const asked = voiceMicrophoneConstraints();
    (await untilAsked())(null, true);
    await asked;

    expect((await voiceMicrophoneConstraints()).audio.deviceId).toBeUndefined();
    expect(voiceMicrophone.store.state.choice).toBeUndefined();
  });

  it('ignores a corrupt saved choice rather than throwing', async () => {
    stubBrowser([built, usb]);
    for (const raw of ['{', '{"deviceId":42,"inputs":[]}', '{"deviceId":null}', 'null']) {
      store['doompi.voice.microphone.v1'] = raw;
      const constraints = voiceMicrophoneConstraints();
      (await untilAsked())(null, false);
      await constraints;
    }
  });
});