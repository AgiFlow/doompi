import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  physicalDefaultInput,
  voiceMicrophone,
  voiceMicrophoneConstraints,
} from '../src/web/stores/voiceMicrophoneStore';

const physical = { deviceId: 'physical', groupId: 'built-in', label: 'MacBook microphone' };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  voiceMicrophone.reset();
});
describe('browser microphone selection', () => {
  it('resolves the default alias only when exactly one physical input matches', () => {
    const alias = { ...physical, deviceId: 'default' };
    expect(physicalDefaultInput([alias, physical])).toEqual(physical);
    expect(physicalDefaultInput([alias, physical, { ...physical, deviceId: 'duplicate' }])).toBeUndefined();
    expect(physicalDefaultInput([{ ...alias, groupId: '' }, physical])).toBeUndefined();
  });
  it('uses the persisted physical input with exact constraints and rejects a disappeared device', async () => {
    let available = true;
    vi.stubGlobal('localStorage', { getItem: () => 'browser-stable', setItem: vi.fn() });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => (available ? [{ ...physical, kind: 'audioinput' }] : []),
        getUserMedia: async () => ({ getTracks: () => [] }),
      },
    });
    const fetch = vi
      .spyOn(sealedTransport, 'fetch')
      .mockImplementation(async () => Response.json({ deviceId: 'physical', inputs: available ? [physical] : [] }));
    expect(await voiceMicrophoneConstraints()).toMatchObject({ audio: { deviceId: { exact: 'physical' } } });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/global/plugin/voice/clients/browser-stable/inputs');
    available = false;
    await expect(voiceMicrophoneConstraints()).rejects.toThrow('unavailable');
  });
});
