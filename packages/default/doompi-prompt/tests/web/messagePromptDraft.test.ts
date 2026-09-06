import { describe, expect, it, vi } from 'vitest';
import { requestMessagePromptDraft, subscribeMessagePromptDraft } from '../../src/web/lib/messagePromptDraft.ts';

describe('message prompt draft handoff', () => {
  it('copies user message text into an editable unnamed draft', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMessagePromptDraft(listener);

    requestMessagePromptDraft({ sessionId: 'session-1', messageId: 'message-1', text: 'Review this change' });

    expect(listener).toHaveBeenCalledWith({ name: '', text: 'Review this change', original: '' });
    unsubscribe();
  });

  it('retains a request until the dialog owner subscribes', () => {
    requestMessagePromptDraft({ sessionId: 'session-1', messageId: 'message-2', text: 'Write the tests' });
    const listener = vi.fn();

    const unsubscribe = subscribeMessagePromptDraft(listener);

    expect(listener).toHaveBeenCalledWith({ name: '', text: 'Write the tests', original: '' });
    unsubscribe();
  });
});
