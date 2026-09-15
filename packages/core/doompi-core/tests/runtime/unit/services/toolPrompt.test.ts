import { describe, expect, it } from 'vitest';

import { formatToolPrompt } from '../../../../src/services/toolPrompt';

describe('tool prompt block', () => {
  it('lists tools with a snippet, de-duplicates guidelines, and keeps Pi ordering', () => {
    expect(
      formatToolPrompt([
        { name: 'write_plan', promptSnippet: 'Save the implementation plan' },
        {
          name: 'complete_plan',
          promptSnippet: 'Request exit-or-continue approval',
          promptGuidelines: ['Call complete_plan without a decision.', 'Shared rule.'],
        },
        { name: 'read', promptGuidelines: ['Shared rule.'] },
      ]),
    ).toBe(
      [
        'Available tools:',
        '- write_plan: Save the implementation plan',
        '- complete_plan: Request exit-or-continue approval',
        '',
        'Guidelines:',
        '- Call complete_plan without a decision.',
        '- Shared rule.',
      ].join('\n'),
    );
  });

  it('is empty when no tool contributes prompt text, so the prompt gains no blank section', () => {
    expect(formatToolPrompt([{ name: 'read' }, { name: 'bash', promptSnippet: '  ' }])).toBe('');
  });
});
