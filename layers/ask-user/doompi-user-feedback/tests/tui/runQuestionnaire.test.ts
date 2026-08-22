import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { runTuiQuestionnaire } from '../../src/tui/runQuestionnaire.ts';

describe('runTuiQuestionnaire', () => {
  it('uses Pi custom UI inline instead of a detached overlay', async () => {
    const expected = { answers: [], cancelled: true };
    const custom = vi.fn(async () => expected);
    const context = { ui: { custom } } as unknown as ExtensionContext;

    await expect(
      runTuiQuestionnaire(
        context,
        {
          questions: [
            {
              header: 'Choice',
              question: 'Choose one',
              options: [{ label: 'A', description: 'Option A' }],
            },
          ],
        },
        'ctrl+]',
      ),
    ).resolves.toBe(expected);

    expect(custom).toHaveBeenCalledOnce();
    expect(custom.mock.calls[0]).toHaveLength(1);
  });
});
