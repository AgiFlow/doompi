import { describe, expect, it, vi } from 'vitest';
import { DOOM_VOICE_AUTO_MODE_ID, DOOM_VOICE_SOURCE } from '@agimon-ai/doompi-extension-contracts/narration';
import {
  buildVoiceToolResult,
  createVoiceQuestionHandoff,
  formatVoiceQuestionPrompt,
  VOICE_WAIT_MESSAGE,
  VoiceQuestionHandoff,
} from '../../src/adapters/doom/voiceQuestionHandoff.js';
import type { QuestionParams } from '../../src/schemas/questionnaire.js';

const params: QuestionParams = {
  questions: [
    {
      question: 'Continue?',
      header: 'Continue',
      options: [
        { label: 'Yes', description: 'Continue.' },
        { label: 'No', description: 'Stop.' },
      ],
    },
  ],
};

function status(
  source = DOOM_VOICE_SOURCE,
  id = DOOM_VOICE_AUTO_MODE_ID,
  activation: 'inactive' | 'active' = 'active',
) {
  return {
    descriptor: { source, id, label: 'VOICE', description: 'Voice mode', order: 30, actions: [] },
    state: { activation, condition: 'ready' as const, actions: [] },
    ownerGeneration: 'owner-1',
    registrationId: 'registration-1',
    stateRevision: 1,
  };
}

describe('VoiceQuestionHandoff', () => {
  it('does nothing when autonomous voice is inactive', async () => {
    const request = vi.fn();
    const handoff = new VoiceQuestionHandoff(
      { list: () => [status(DOOM_VOICE_SOURCE, DOOM_VOICE_AUTO_MODE_ID, 'inactive')] },
      { request },
      () => 'spoken questions',
    );

    await expect(handoff.handoff(params)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('requires both the exact source and voice-auto mode id', async () => {
    const request = vi.fn();
    const handoff = new VoiceQuestionHandoff(
      { list: () => [status('@example/not-voice')] },
      { request },
      () => 'spoken questions',
    );

    await expect(handoff.handoff(params)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('narrates once and returns an awaiting voice result while active', async () => {
    const request = vi.fn();
    const handoff = new VoiceQuestionHandoff({ list: () => [status()] }, { request }, () => 'all spoken questions');

    const details = await handoff.handoff(params);
    expect(request).toHaveBeenCalledExactlyOnceWith({ text: 'all spoken questions' });
    expect(details).toEqual({
      answers: [],
      cancelled: false,
      delivery: 'voice',
      awaitingResponse: true,
      voicePrompt: 'Continue?\n  1. Yes\n  2. No\n  Type something.',
    });
    expect(buildVoiceToolResult(details!)).toEqual({
      content: [
        {
          type: 'text',
          text: `Continue?\n  1. Yes\n  2. No\n  Type something.\n\n${VOICE_WAIT_MESSAGE}`,
        },
      ],
      details,
      terminate: true,
    });
  });

  it('creates a direct handoff over the injected catalog and narration services', async () => {
    const request = vi.fn(async () => undefined);
    const handoff = createVoiceQuestionHandoff({ list: () => [status()] }, { request });

    await expect(handoff.handoff(params)).resolves.toMatchObject({ delivery: 'voice' });
    expect(request).toHaveBeenCalledExactlyOnceWith({ text: expect.stringContaining('Continue?') });
  });

  it('falls back when the generated narration is empty', async () => {
    const request = vi.fn();
    const handoff = new VoiceQuestionHandoff({ list: () => [status()] }, { request }, () => ' \n\t ');

    await expect(handoff.handoff(params)).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('formats every question and option without descriptions or previews', () => {
    expect(
      formatVoiceQuestionPrompt({
        questions: [
          {
            question: 'Choose colors',
            header: 'Colors',
            multiSelect: true,
            options: [
              { label: 'Red', description: 'Warm', preview: 'red preview' },
              { label: 'Blue', description: 'Cool' },
            ],
          },
          {
            question: 'Choose size',
            header: 'Size',
            options: [
              { label: 'Small', description: 'Compact' },
              { label: 'Large', description: 'Roomy' },
            ],
          },
        ],
      }),
    ).toBe(
      '1. Choose colors (Select all that apply.)\n  1. Red\n  2. Blue\n  Type something.\n\n2. Choose size\n  1. Small\n  2. Large\n  Type something.',
    );
  });
});
