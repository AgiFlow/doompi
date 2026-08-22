import { describe, expect, it, vi } from 'vitest';
import { applyTranscriptPolicy } from '../src/services/transcriptPolicy.ts';
import { VoiceDelivery, type VoiceDeliveryResult } from '../src/services/voiceDelivery.ts';

const request = {
  sessionId: 'session-1',
  captureId: 'capture-1',
  turnId: 'turn-1',
  revision: 1,
  text: 'exact user prompt',
};

describe('transcript policy', () => {
  const phrases = {
    startPhrases: ['hey doom'],
    stopPhrases: ['stop speaking'],
    narrationReferences: ['The plan is ready for review'],
  } as const;

  it('rejects promoted narration residuals that lack intentional address', () => {
    expect(
      applyTranscriptPolicy({
        ...phrases,
        transcript: 'The plan is ready strange recognition from the speaker',
        narrationOverlapPromoted: true,
      }),
    ).toEqual({ action: 'discard', reason: 'narration-echo' });
  });

  it('removes narration tail and intentional address from a promoted user turn', () => {
    expect(
      applyTranscriptPolicy({
        ...phrases,
        transcript: 'The plan is ready four four hey doom run all tests',
        narrationOverlapPromoted: true,
      }),
    ).toEqual({ action: 'deliver', text: 'run all tests' });
  });

  it('still requires intentional address when a promoted transcript has no aligned narration tokens', () => {
    expect(
      applyTranscriptPolicy({
        ...phrases,
        transcript: 'run all tests',
        narrationOverlapPromoted: true,
      }),
    ).toEqual({ action: 'discard', reason: 'narration-echo' });
    expect(
      applyTranscriptPolicy({
        ...phrases,
        transcript: 'hey doom run all tests',
        narrationOverlapPromoted: true,
      }),
    ).toEqual({ action: 'deliver', text: 'run all tests' });
  });

  it('does not require intentional address for a clean post-playback turn', () => {
    expect(
      applyTranscriptPolicy({
        ...phrases,
        transcript: 'run all tests',
        narrationOverlapPromoted: false,
      }),
    ).toEqual({ action: 'deliver', text: 'run all tests' });
  });
});

describe('VoiceDelivery', () => {
  it('retains one bounded delivery while blocked and flushes it exactly once', () => {
    const deliver = vi.fn();
    const results: VoiceDeliveryResult[] = [];
    const delivery = new VoiceDelivery({ deliver, onResult: (result) => results.push(result) });

    delivery.setBlocked(true);
    delivery.submit(request);
    expect(deliver).not.toHaveBeenCalled();

    delivery.setBlocked(false);
    delivery.setBlocked(false);

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(request.text);
    expect(results).toEqual([
      { kind: 'delivered', sessionId: 'session-1', captureId: 'capture-1', turnId: 'turn-1', revision: 1 },
    ]);
  });

  it('reports failure without claiming delivery', () => {
    const results: VoiceDeliveryResult[] = [];
    const delivery = new VoiceDelivery({
      deliver: () => {
        throw new Error('editor unavailable');
      },
      onResult: (result) => results.push(result),
    });

    delivery.submit(request);

    expect(results).toEqual([
      {
        kind: 'failed',
        sessionId: 'session-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
        revision: 1,
        code: 'editor unavailable',
      },
    ]);
  });

  it('drops pending delivery on hard cleanup', () => {
    const deliver = vi.fn();
    const delivery = new VoiceDelivery({ deliver, onResult: vi.fn() });
    delivery.setBlocked(true);
    delivery.submit(request);
    delivery.clear();
    delivery.setBlocked(false);

    expect(deliver).not.toHaveBeenCalled();
  });
});
