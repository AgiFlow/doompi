import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveVoiceCommandCorrector } from '../src/adapters/pi/voice.ts';
import {
  compactVoiceCommandContext,
  MAX_VOICE_COMMAND_CONTEXT_BYTES,
  type VoiceCommandCorrectionModelRequest,
  VoiceCommandCorrector,
} from '../src/services/commandCorrection.ts';

function modelReturning(output: string) {
  const complete = vi.fn(async (_request: VoiceCommandCorrectionModelRequest) => output);
  return { complete };
}

afterEach(() => vi.useRealTimers());

describe('VoiceCommandCorrector', () => {
  it('applies only a small exact context-grounded ASR correction', async () => {
    const model = modelReturning(JSON.stringify({ corrections: [{ source: 'doom pie', replacement: 'DoomPi' }] }));
    const corrector = new VoiceCommandCorrector(model);

    await expect(
      corrector.correct(
        {
          transcript: 'please update doom pie voice',
          context: { tasks: ['Update DoomPi voice commands'] },
        },
        new AbortController().signal,
      ),
    ).resolves.toBe('please update DoomPi voice');

    const request = model.complete.mock.calls[0]![0];
    expect(request.cacheRetention).toBe('none');
    expect(request.maxTokens).toBe(256);
    expect(request.systemPrompt).toContain('untrusted quoted data');
    expect(JSON.parse(request.input)).toEqual({
      version: 1,
      transcript: 'please update doom pie voice',
      context: { tasks: ['Update DoomPi voice commands'] },
    });
  });

  it('does not call the model without usable context or for an oversized transcript', async () => {
    const model = modelReturning(JSON.stringify({ corrections: [] }));
    const corrector = new VoiceCommandCorrector(model);
    const oversized = 'a'.repeat(4_097);

    await expect(corrector.correct({ transcript: 'leave this exact' }, new AbortController().signal)).resolves.toBe(
      'leave this exact',
    );
    await expect(
      corrector.correct({ transcript: oversized, context: { tasks: ['Relevant term'] } }, new AbortController().signal),
    ).resolves.toBe(oversized);
    expect(model.complete).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'rewritten object',
      output: JSON.stringify({ transcript: 'replace the whole request' }),
      transcript: 'run tests',
      context: { tasks: ['Run tests'] },
      error: /corrections array/u,
    },
    {
      name: 'changed number',
      output: JSON.stringify({ corrections: [{ source: '50', replacement: '500' }] }),
      transcript: 'run 50 tests',
      context: { tasks: ['Run 500 tests'] },
      error: /change user content/u,
    },
    {
      name: 'changed action',
      output: JSON.stringify({ corrections: [{ source: 'deploy', replacement: 'Destroy' }] }),
      transcript: 'deploy production',
      context: { tasks: ['Destroy production'] },
      error: /change user content/u,
    },
    {
      name: 'changed negation',
      output: JSON.stringify({ corrections: [{ source: 'do not', replacement: 'Donut' }] }),
      transcript: 'do not deploy',
      context: { tasks: ['Donut deploy'] },
      error: /change user content/u,
    },
    {
      name: 'substring source',
      output: JSON.stringify({ corrections: [{ source: 'pi', replacement: 'Pi' }] }),
      transcript: 'compile the package',
      context: { tasks: ['Use Pi'] },
      error: /exact transcript phrase/u,
    },
    {
      name: 'non-context replacement',
      output: JSON.stringify({ corrections: [{ source: 'doom pie', replacement: 'DoomPy' }] }),
      transcript: 'open doom pie',
      context: { tasks: ['Open DoomPi'] },
      error: /exact context phrase/u,
    },
    {
      name: 'redaction marker',
      output: JSON.stringify({ corrections: [{ source: 'path', replacement: '[path]' }] }),
      transcript: 'open path',
      context: { tasks: ['Open /Users/alice/private.txt'] },
      error: /redaction marker/u,
    },
  ])('rejects $name rather than changing user meaning', async ({ output, transcript, context, error }) => {
    const corrector = new VoiceCommandCorrector(modelReturning(output));
    await expect(corrector.correct({ transcript, context }, new AbortController().signal)).rejects.toThrow(error);
  });

  it('rejects overlapping patches and invalid model JSON', async () => {
    const context = { tasks: ['DoomPi voice', 'Pi voice'] };
    const overlapping = new VoiceCommandCorrector(
      modelReturning(
        JSON.stringify({
          corrections: [
            { source: 'doom pie', replacement: 'DoomPi' },
            { source: 'pie voice', replacement: 'Pi voice' },
          ],
        }),
      ),
    );
    await expect(
      overlapping.correct({ transcript: 'doom pie voice', context }, new AbortController().signal),
    ).rejects.toThrow(/overlap/u);
    await expect(
      new VoiceCommandCorrector(modelReturning('not json')).correct(
        { transcript: 'doom pie', context },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/one JSON object/u);
  });

  it('aborts the model at its deadline', async () => {
    vi.useFakeTimers();
    let modelSignal: AbortSignal | undefined;
    const complete = vi.fn((request: VoiceCommandCorrectionModelRequest) => {
      modelSignal = request.signal;
      return new Promise<string>(() => undefined);
    });
    const correction = new VoiceCommandCorrector({ complete }, 25).correct(
      { transcript: 'open doom pie', context: { tasks: ['Open DoomPi'] } },
      new AbortController().signal,
    );
    const rejection = expect(correction).rejects.toThrow(/timed out/u);

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(modelSignal?.aborted).toBe(true);
  });

  it('uses the configured autonomous model bridge without cache retention or reasoning', async () => {
    const complete = vi.fn(async (..._args: unknown[]) => ({
      stopReason: 'stop',
      content: [{ type: 'text', text: '{"corrections":[]}' }],
    }));
    const corrector = resolveVoiceCommandCorrector('provider/model', {
      modelRegistry: {
        find: () => ({ provider: 'provider', id: 'model', api: 'test' }),
        hasConfiguredAuth: () => true,
        complete,
      },
    } as never);

    await expect(
      corrector.correct(
        { transcript: 'open doom pie', context: { tasks: ['Open DoomPi'] } },
        new AbortController().signal,
      ),
    ).resolves.toBe('open doom pie');

    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      cacheRetention: 'none',
      reasoningEffort: 'none',
      maxRetries: 0,
      maxTokens: 256,
    });
  });

  it('propagates caller cancellation and aborts outstanding model work', async () => {
    let modelSignal: AbortSignal | undefined;
    const complete = vi.fn((request: VoiceCommandCorrectionModelRequest) => {
      modelSignal = request.signal;
      return new Promise<string>(() => undefined);
    });
    const abortController = new AbortController();
    const correction = new VoiceCommandCorrector({ complete }).correct(
      { transcript: 'open doom pie', context: { tasks: ['Open DoomPi'] } },
      abortController.signal,
    );
    await Promise.resolve();

    abortController.abort(new Error('voice stopped'));

    await expect(correction).rejects.toThrow('voice stopped');
    expect(modelSignal?.aborted).toBe(true);
  });
});

describe('compactVoiceCommandContext', () => {
  it('redacts common sensitive values and strips invisible controls', () => {
    const context = compactVoiceCommandContext({
      pendingQuestions: [
        'Choose target\u202E token=supersecretvalue123 https://user:pass@example.com/private /Users/alice/key.pem alice@example.com',
        'Use ghp_abcdefghijklmnopqrstuvwxyz1234567890 or AKIAABCDEFGHIJKLMNOP',
      ],
      tasks: ['Read C:\\Users\\alice\\secret.txt', '-----BEGIN PRIVATE KEY----- abc'],
    });
    const serialized = JSON.stringify(context);

    expect(serialized).not.toContain('supersecretvalue123');
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('AKIA');
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('\u202E');
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('[path]');
  });

  it('bounds item counts, item length, and the encoded payload', () => {
    const context = compactVoiceCommandContext({
      pendingQuestions: Array.from({ length: 10 }, (_, index) => `Question ${index} ${'q'.repeat(20_000)}`),
      tasks: Array.from({ length: 20 }, (_, index) => `Task ${index} ${'t'.repeat(20_000)}`),
    });

    expect(context?.pendingQuestions?.length).toBeLessThanOrEqual(4);
    expect(context?.tasks?.length).toBeLessThanOrEqual(8);
    for (const item of [...(context?.pendingQuestions ?? []), ...(context?.tasks ?? [])])
      expect(Array.from(item).length).toBeLessThanOrEqual(320);
    expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(
      MAX_VOICE_COMMAND_CONTEXT_BYTES,
    );
  });
});
