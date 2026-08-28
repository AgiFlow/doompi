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
  /**
   * Composition phrases are pinned away from `hey doom` in most cases below so the
   * address gate can be exercised on its own. The shipped defaults deliberately share
   * that phrase, which has its own test.
   */
  const compositionPhrases = {
    open: ['start dictation'],
    send: ["that's it"],
    cancel: ['scratch that'],
  } as const;
  const phrases = {
    startPhrases: ['hey doom'],
    stopPhrases: ['stop speaking'],
    narrationReferences: ['The plan is ready for review'],
    compositionPhrases,
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

  it('opens a draft when the address phrase is also the configured compose-open phrase', () => {
    // The shipped default: `hey doom` is both the barge-in address and the long-prompt
    // opener, so addressing the agent starts collecting rather than delivering.
    expect(
      applyTranscriptPolicy({
        ...phrases,
        compositionPhrases: { open: ['hey doom'], send: ["that's it"], cancel: ['scratch that'] },
        transcript: 'hey doom run all tests',
        narrationOverlapPromoted: true,
      }),
    ).toEqual({ action: 'compose-open', text: 'run all tests' });
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

  it('opens composition before a matching configured start phrase is stripped', () => {
    expect(
      applyTranscriptPolicy({
        ...phrases,
        startPhrases: ['doom'],
        compositionPhrases: { open: ['doom prompt'], send: ['doom send'], cancel: ['doom cancel'] },
        transcript: 'Doom, prompt: preserve My Punctuation.',
        compositionState: 'inactive',
      }),
    ).toEqual({ action: 'compose-open', text: 'preserve My Punctuation.' });
  });

  it('requires standalone send and cancel commands while collecting', () => {
    const collecting = {
      ...phrases,
      startPhrases: ['doom'],
      compositionPhrases: { open: ['doom prompt'], send: ['doom send'], cancel: ['doom cancel'] },
      compositionState: 'collecting' as const,
    };
    expect(applyTranscriptPolicy({ ...collecting, transcript: 'Doom, send.' })).toEqual({ action: 'compose-send' });
    expect(applyTranscriptPolicy({ ...collecting, transcript: 'doom cancel' })).toEqual({ action: 'compose-cancel' });
    expect(applyTranscriptPolicy({ ...collecting, transcript: 'doom send this exact phrase' })).toEqual({
      action: 'compose-append',
      text: 'send this exact phrase',
    });
  });

  it('keeps send and cancel as ordinary text outside composition', () => {
    const inactive = {
      ...phrases,
      startPhrases: [],
      compositionPhrases: { open: ['doom prompt'], send: ['doom send'], cancel: ['doom cancel'] },
      compositionState: 'inactive' as const,
    };
    expect(applyTranscriptPolicy({ ...inactive, transcript: 'doom send' })).toEqual({
      action: 'deliver',
      text: 'doom send',
    });
    expect(applyTranscriptPolicy({ ...inactive, transcript: 'doom cancel' })).toEqual({
      action: 'deliver',
      text: 'doom cancel',
    });
  });

  describe('command intent by utterance length', () => {
    const collecting = { ...phrases, startPhrases: [], compositionState: 'collecting' as const };

    it.each(["that's it", 'thats it', 'that sit', "That's it."])(
      'submits when the segment is nothing but the command: %s',
      (transcript) => {
        expect(applyTranscriptPolicy({ ...collecting, transcript })).toEqual({ action: 'compose-send' });
      },
    );

    it.each([
      "that's it exactly",
      "yeah that's it exactly",
      'I want it to be exactly thats it',
      "I think that's it, but check the tests first",
      // No sentence break before the phrase, so it reads as continuing the thought. A
      // missed command costs one repetition; a false one submits a half-written prompt.
      "and that's it",
      'is that it',
    ])('keeps %s as draft content', (transcript) => {
      expect(applyTranscriptPolicy({ ...collecting, transcript })).toMatchObject({ action: 'compose-append' });
    });

    it('submits a trailing command behind a sentence break and keeps the content', () => {
      expect(applyTranscriptPolicy({ ...collecting, transcript: "just log the error, that's it" })).toEqual({
        action: 'compose-send',
        text: 'just log the error,',
      });
    });

    it('keeps a leading filler rather than dropping it', () => {
      // Separating "Ok," from real content would need a filler list per language. The
      // draft gets one noisy token, which beats silently discarding a word the user said.
      expect(applyTranscriptPolicy({ ...collecting, transcript: "Ok, that's it." })).toEqual({
        action: 'compose-send',
        text: 'Ok,',
      });
    });

    it('cancels on a short cancel command and tolerates a suffix', () => {
      expect(applyTranscriptPolicy({ ...collecting, transcript: 'scratch that' })).toEqual({
        action: 'compose-cancel',
      });
      expect(applyTranscriptPolicy({ ...collecting, transcript: 'Scratch that.' })).toEqual({
        action: 'compose-cancel',
      });
    });

    it('keeps a long cancel-shaped sentence as content', () => {
      expect(
        applyTranscriptPolicy({ ...collecting, transcript: 'scratch that idea and use the other one' }),
      ).toMatchObject({ action: 'compose-append' });
    });
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

  it('retains queued follow-up intent through a blocked delivery', () => {
    const deliver = vi.fn();
    const delivery = new VoiceDelivery({ deliver, onResult: vi.fn() });
    delivery.setBlocked(true);
    delivery.submit({ ...request, intent: 'queuedFollowUp' });
    delivery.setBlocked(false);
    expect(deliver).toHaveBeenCalledWith(request.text, 'queuedFollowUp');
  });

  it('rejects blank text without invoking delivery', () => {
    const deliver = vi.fn();
    const results: VoiceDeliveryResult[] = [];
    const delivery = new VoiceDelivery({ deliver, onResult: (result) => results.push(result) });

    delivery.submit({ ...request, text: '  \n ' });

    expect(deliver).not.toHaveBeenCalled();
    expect(results).toEqual([
      {
        kind: 'failed',
        sessionId: 'session-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
        revision: 1,
        code: 'blank transcript',
      },
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
