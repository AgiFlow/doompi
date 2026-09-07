import { describe, expect, it, vi } from 'vitest';
import {
  requestMessagePromptDraft,
  requestPromptDialogOpen,
  subscribePromptDialogRequest,
} from '../../src/web/lib/messagePromptDraft.ts';

describe('prompt dialog requests', () => {
  it('copies user message text into an editable unnamed draft', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePromptDialogRequest(listener);

    requestMessagePromptDraft({ sessionId: 'session-1', messageId: 'message-1', text: 'Review this change' });

    expect(listener).toHaveBeenCalledWith({ draft: { name: '', text: 'Review this change', original: '' } });
    unsubscribe();
  });

  it('retains a request until the dialog owner subscribes', () => {
    requestMessagePromptDraft({ sessionId: 'session-1', messageId: 'message-2', text: 'Write the tests' });
    const listener = vi.fn();

    const unsubscribe = subscribePromptDialogRequest(listener);

    expect(listener).toHaveBeenCalledWith({ draft: { name: '', text: 'Write the tests', original: '' } });
    unsubscribe();
  });

  it('asks for the picker, not the editor, when the composer menu entry is used', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePromptDialogRequest(listener);

    requestPromptDialogOpen();

    expect(listener).toHaveBeenCalledWith({});
    unsubscribe();
  });
});
