import { describe, expect, it, vi } from 'vitest';

import { LiveVoiceController } from '../src/controllers/liveVoiceController';
import { VoiceModeController, type ModeVoiceController } from '../src/controllers/voiceModeController';
import type { RealtimeHost } from '../src/services/realtimeHost';
import type { AutoCaptureActivationState, AutoCaptureUi, IClock } from '../src/types';

function controller(): ModeVoiceController {
  let state: AutoCaptureActivationState = 'disabled';
  return {
    get state() {
      return state;
    },
    activationId: 0,
    activationError: undefined,
    microphoneMuted: false,
    activate: vi.fn(async () => {
      state = 'active';
    }),
    deactivate: vi.fn(async () => {
      state = 'disabled';
    }),
    toggle: vi.fn(async () => {
      state = state === 'disabled' ? 'active' : 'disabled';
    }),
    shutdown: vi.fn(async () => {
      state = 'disabled';
    }),
    setMicrophoneMuted: vi.fn(),
    interruptSpeech: vi.fn(),
    askUserBlocked: vi.fn(),
    narrateAgent: vi.fn(async () => 'completed' as const),
    narrateExternal: vi.fn(async () => 'completed' as const),
    narrateFallback: vi.fn(async () => 'completed' as const),
  };
}

const ui: AutoCaptureUi = {
  notify: vi.fn(),
  setStatus: vi.fn(),
  setIndicator: vi.fn(),
};

describe('VoiceModeController', () => {
  it('selects mode only on disabled activation and keeps public activation IDs monotonic', async () => {
    const legacy = controller();
    const live = controller();
    let configured: 'legacy' | 'live' = 'live';
    const getMode = vi.fn(() => configured);
    const modes = new VoiceModeController({ legacy, live, getMode });

    await modes.activate(ui);
    configured = 'legacy';
    await modes.activate(ui);

    expect(modes.selectedMode).toBe('live');
    expect(modes.activationId).toBe(1);
    expect(getMode).toHaveBeenCalledOnce();
    expect(live.activate).toHaveBeenCalledOnce();
    expect(legacy.activate).not.toHaveBeenCalled();

    await modes.deactivate(ui);
    await modes.activate(ui);
    expect(modes.selectedMode).toBe('legacy');
    expect(modes.activationId).toBe(2);
  });

  it('routes controls to the selected controller and shuts down both', async () => {
    const legacy = controller();
    const live = controller();
    const modes = new VoiceModeController({ legacy, live, getMode: () => 'live' });
    await modes.activate(ui);

    modes.interruptSpeech();
    modes.setMicrophoneMuted(true);

    expect(live.interruptSpeech).toHaveBeenCalledOnce();
    expect(live.setMicrophoneMuted).toHaveBeenCalledWith(true);
    expect(legacy.interruptSpeech).not.toHaveBeenCalled();

    await modes.shutdown(ui);
    expect(legacy.shutdown).toHaveBeenCalledWith(ui);
    expect(live.shutdown).toHaveBeenCalledWith(ui);
  });
  it('preserves approval blocking established before the first live activation', async () => {
    const legacy = controller();
    const send = vi.fn();
    const host: RealtimeHost = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      control: vi.fn(async () => undefined),
      poll: vi.fn<RealtimeHost['poll']>(async (activationId) => ({
        activationId,
        state: 'active',
        cursor: 2,
        events: [
          { sequence: 1, event: { type: 'transcript', role: 'user', text: 'yes', complete: true } },
          { sequence: 2, event: { type: 'request', requestId: 'approval', text: 'approve the pending action' } },
        ],
      })),
    };
    const clock: IClock = { now: () => Date.now(), setTimeout, setInterval, clear: clearTimeout };
    const live = new LiveVoiceController({
      host,
      clock,
      send,
      contextText: () => '',
      manualState: () => 'idle',
      isBusy: () => false,
    });
    const modes = new VoiceModeController({ legacy, live, getMode: () => 'live' });
    try {
      modes.askUserBlocked(true);
      await modes.activate(ui);
      for (let index = 0; index < 30; index += 1) await Promise.resolve();
      expect(modes.state).toBe('active');
      expect(send).not.toHaveBeenCalled();
      expect(host.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.stringContaining('rejected')]),
        expect.any(AbortSignal),
      );
      modes.askUserBlocked(false);
      expect(legacy.askUserBlocked).toHaveBeenLastCalledWith(false);
    } finally {
      await modes.shutdown(ui);
    }
  });

  it('routes toggle and narration, and shuts down both even if one fails', async () => {
    const legacy = controller();
    const live = controller();
    const modes = new VoiceModeController({ legacy, live, getMode: () => 'live' });
    await modes.toggle(ui);
    expect(modes.activationError).toBeUndefined();
    expect(modes.microphoneMuted).toBe(false);
    await expect(modes.narrateAgent('a')).resolves.toBe('completed');
    await expect(modes.narrateExternal('b')).resolves.toBe('completed');
    await expect(modes.narrateFallback('c')).resolves.toBe('completed');
    await modes.toggle(ui);
    expect(modes.state).toBe('disabled');
    vi.mocked(legacy.shutdown).mockRejectedValueOnce(new Error('shutdown failed'));
    await expect(modes.shutdown(ui)).rejects.toThrow('shutdown failed');
    expect(live.shutdown).toHaveBeenCalledOnce();
  });
});
