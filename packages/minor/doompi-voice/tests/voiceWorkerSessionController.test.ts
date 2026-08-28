import type { DoomConfig, IDoomConfigLoader } from '@agimon-ai/doompi-config';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceWorkerClientOptions } from '../src/adapters/process/voiceWorkerClient.ts';
import {
  type VoiceWorkerSessionClient,
  VoiceWorkerSessionController,
} from '../src/adapters/process/voiceWorkerSessionController.ts';
import { VOICE_WORKER_PROTOCOL_VERSION } from '../src/services/voiceWorkerProtocol.ts';
import type { IClock, TimerHandle, VoiceUi } from '../src/types/index.ts';

const doomConfig: DoomConfig = {
  projectTrust: 'ask',
  voice: {
    engine: 'mlx-whisper',
    language: 'auto',
    recorder: { device: 'none:default' },
    adapters: { 'mlx-whisper': { model: { id: 'local-model' } } },
  },
};

class SessionClock implements IClock {
  public value = 1_000;
  public now(): number {
    return this.value;
  }
  public setInterval(): TimerHandle {
    return { kind: 'interval' } as unknown as TimerHandle;
  }
  public setTimeout(): TimerHandle {
    return { kind: 'timeout' } as unknown as TimerHandle;
  }
  public clear(): void {}
}

function voiceUi(initial = ''): VoiceUi & { text: string } {
  return {
    text: initial,
    notify: vi.fn(),
    setStatus: vi.fn(),
    setIndicator: vi.fn(),
    getEditorText() {
      return this.text;
    },
    setEditorText(text: string) {
      this.text = text;
    },
  };
}

function harness(config: DoomConfig = doomConfig) {
  let options: VoiceWorkerClientOptions | undefined;
  const client: VoiceWorkerSessionClient = {
    start: vi.fn(async () => undefined),
    beginCapture: vi.fn(),
    finalizeCapture: vi.fn(),
    cancelCapture: vi.fn(),
    acknowledgeCandidate: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  };
  const configs: IDoomConfigLoader = { load: () => config };
  const controller = new VoiceWorkerSessionController(configs, new SessionClock(), (createdOptions) => {
    options = createdOptions;
    return client;
  });
  return {
    controller,
    client,
    emit: (event: Parameters<VoiceWorkerClientOptions['onEvent']>[0]) => options?.onEvent(event),
  };
}

describe('VoiceWorkerSessionController', () => {
  it('uses the worker for explicit-stop dictation and appends the exact final transcript', async () => {
    const { controller, client, emit } = harness();
    const ui = voiceUi('existing');

    await controller.toggle(ui);
    expect(controller.state).toBe('recording');
    expect(client.beginCapture).toHaveBeenCalledTimes(1);
    const begin = vi.mocked(client.beginCapture).mock.calls[0]![0];
    expect(begin).toMatchObject({ mode: 'manual', maxDurationMs: 300_000, transcriptionTimeoutMs: 15_000 });
    await controller.toggle(ui);
    expect(controller.state).toBe('transcribing');
    expect(client.finalizeCapture).toHaveBeenCalledWith(begin.sessionId, begin.captureId, 'explicit-stop');

    emit({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 1,
      kind: 'transcript-candidate',
      sessionId: begin.sessionId,
      captureId: begin.captureId,
      turnId: begin.turnId,
      revision: 1,
      transcript: 'one, two, three',
      final: true,
    });

    expect(ui.text).toBe('existing one, two, three');
    expect(client.acknowledgeCandidate).toHaveBeenCalledWith(begin.sessionId, begin.turnId, 1, 'committed');
    expect(controller.state).toBe('idle');
  });

  it('acknowledges an empty final result after the worker has drained capture', async () => {
    const { controller, client, emit } = harness();
    const ui = voiceUi();
    await controller.toggle(ui);
    const begin = vi.mocked(client.beginCapture).mock.calls[0]![0];
    await controller.toggle(ui);

    emit({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 2,
      kind: 'drained',
      sessionId: begin.sessionId,
      captureId: begin.captureId,
      turnId: begin.turnId,
      revision: 1,
    });
    expect(client.acknowledgeCandidate).not.toHaveBeenCalled();
    emit({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 3,
      kind: 'failure',
      code: 'empty_transcript',
      recoverable: true,
      sessionId: begin.sessionId,
      captureId: begin.captureId,
      turnId: begin.turnId,
      revision: 1,
    });

    expect(client.acknowledgeCandidate).toHaveBeenCalledWith(begin.sessionId, begin.turnId, 1, 'discarded');
    expect(controller.state).toBe('idle');
  });

  it('cancels worker-owned capture and transcription during shutdown', async () => {
    const { controller, client } = harness();
    const ui = voiceUi();
    await controller.toggle(ui);
    const begin = vi.mocked(client.beginCapture).mock.calls[0]![0];

    await controller.shutdown(ui);

    expect(client.cancelCapture).toHaveBeenCalledWith(begin.sessionId, begin.captureId);
    expect(client.shutdown).toHaveBeenCalledWith('session-shutdown');
    expect(controller.state).toBe('idle');
  });

  it('does not surface an intentional shutdown as a startup failure', async () => {
    const { controller, client } = harness();
    const ui = voiceUi();
    let rejectStartup!: (error: Error) => void;
    vi.mocked(client.start).mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectStartup = reject;
      }),
    );

    const activation = controller.toggle(ui);
    await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(1));
    await controller.shutdown(ui);
    rejectStartup(new Error('Voice worker startup was cancelled by session-shutdown.'));
    await activation;

    expect(ui.notify).not.toHaveBeenCalled();
    expect(controller.state).toBe('idle');
  });

  it('surfaces configuration and worker failures without changing editor text', async () => {
    const missing = harness({ projectTrust: 'ask' });
    const missingUi = voiceUi('safe');
    await missing.controller.toggle(missingUi);
    expect(missing.controller.state).toBe('idle');
    expect(missingUi.notify).toHaveBeenCalledWith(expect.stringContaining('not configured'), 'error');

    const active = harness();
    const ui = voiceUi('safe');
    await active.controller.toggle(ui);
    active.emit({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 4,
      kind: 'failure',
      code: 'capture_failed',
      recoverable: true,
    });
    expect(ui.text).toBe('safe');
    expect(ui.notify).toHaveBeenCalledWith('Voice processing failed: capture_failed', 'error');
  });
});
