import { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';
import {
  AskUserBlockedEventSchema,
  AskUserPromptEventSchema,
  DOOM_ASK_USER_BLOCKED_EVENT,
  DOOM_ASK_USER_PROMPT_EVENT,
} from '../src/schemas/askUser.ts';

const prompt = {
  questions: [
    {
      question: 'Which implementation?',
      header: 'Approach',
      multiSelect: false,
      options: [{ label: 'Cordis', description: 'Use the shared service.', hasPreview: false }],
    },
  ],
};

describe('ask-user Cordis events', () => {
  it('validates the complete prompt and blocked payloads', () => {
    expect(Check(AskUserPromptEventSchema, prompt)).toBe(true);
    expect(Check(AskUserBlockedEventSchema, { active: true })).toBe(true);
    expect(Check(AskUserBlockedEventSchema, { active: 'yes' })).toBe(false);
  });

  it('uses typed namespaced events on the Cordis root', async () => {
    const root = new Context();
    const onPrompt = vi.fn();
    const onBlocked = vi.fn();
    root.on(DOOM_ASK_USER_PROMPT_EVENT, onPrompt);
    root.on(DOOM_ASK_USER_BLOCKED_EVENT, onBlocked);

    root.emit(DOOM_ASK_USER_PROMPT_EVENT, prompt);
    root.emit(DOOM_ASK_USER_BLOCKED_EVENT, { active: true });

    expect(onPrompt).toHaveBeenCalledWith(prompt);
    expect(onBlocked).toHaveBeenCalledWith({ active: true });
    await root.fiber.dispose();
  });
});
