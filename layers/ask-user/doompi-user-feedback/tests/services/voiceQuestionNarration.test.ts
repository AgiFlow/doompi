import { MAX_NARRATION_TEXT_CHARACTERS } from '@agimon-ai/doompi-extension-contracts/narration';
import { describe, expect, it } from 'vitest';
import type { QuestionParams } from '../../src/schemas/questionnaire.js';
import { buildVoiceQuestionNarration, sanitizeVoiceQuestionText } from '../../src/services/voiceQuestionNarration.js';

const questionnaire: QuestionParams = {
  questions: [
    {
      question: 'Which layout should we use?',
      header: 'Layout',
      options: [
        {
          label: 'Grid',
          description: 'Dense card grid.',
          preview: '## private preview\n```tsx\n<Grid />\n```',
        },
        { label: 'List', description: 'Simple vertical list.' },
      ],
    },
    {
      question: 'Which extras should be enabled?',
      header: 'Extras',
      multiSelect: true,
      options: [
        { label: 'Search', description: 'Adds full-text search.' },
        { label: 'Filters', description: 'Adds filtering controls.' },
      ],
    },
  ],
};

describe('buildVoiceQuestionNarration', () => {
  it('speaks every question and option without descriptions or previews', () => {
    const narration = buildVoiceQuestionNarration(questionnaire);

    expect(narration).toContain('Question 1: Which layout should we use?');
    expect(narration).toContain('1, Grid');
    expect(narration).toContain('2, List');
    expect(narration).toContain('Question 2: Which extras should be enabled?');
    expect(narration).toContain('1, Search');
    expect(narration).toContain('2, Filters');
    expect(narration).toContain('You may choose more than one option.');
    expect(narration.match(/answer in your own words/gu)).toHaveLength(2);
    expect(narration).not.toContain('Dense card grid');
    expect(narration).not.toContain('private preview');
  });

  it('removes bounded control, path, token, and code-like text', () => {
    const narration = sanitizeVoiceQuestionText(
      'Read /Users/test/secret.txt\u0000 `code()` token_abcdefghijklmnop <tag> safe words',
      200,
    );

    expect(narration).toBe('Read safe words');
  });

  it('stays within the narration protocol bound', () => {
    const huge: QuestionParams = {
      questions: Array.from({ length: 4 }, (_value, questionIndex) => ({
        question: `${questionIndex} ${'question '.repeat(500)}`,
        header: `Q${questionIndex}`,
        options: Array.from({ length: 4 }, (_option, optionIndex) => ({
          label: `${optionIndex} ${'option '.repeat(100)}`,
          description: 'omitted',
        })),
      })),
    };

    expect(buildVoiceQuestionNarration(huge).length).toBeLessThanOrEqual(MAX_NARRATION_TEXT_CHARACTERS);
  });
});
