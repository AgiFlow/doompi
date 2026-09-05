import { describe, expect, it, vi } from 'vitest';
import { onComposerSubmitted, publishComposerSubmission } from '../../src/web/lib/composerSubmissions.ts';

describe('composer submission publisher', () => {
  it('publishes an immutable context snapshot once and releases listeners', () => {
    const listener = vi.fn();
    const release = onComposerSubmitted(listener);
    const item = {
      kind: 'author-capture',
      source: 'author',
      id: 'capture-1',
      label: 'region',
      content: '{"version":1}',
    };
    publishComposerSubmission({
      sessionId: 's1',
      message: 'rewrite this',
      delivery: 'submit',
      submittedAt: 10,
      contextItems: [item],
    });
    item.content = 'changed';

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toMatchObject({
      sessionId: 's1',
      message: 'rewrite this',
      delivery: 'submit',
      contextItems: [{ content: '{"version":1}' }],
    });
    release();
    publishComposerSubmission({
      sessionId: 's1',
      message: 'again',
      delivery: 'queue',
      submittedAt: 11,
      contextItems: [],
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('isolates plugin observer failures after delivery', () => {
    const afterFailure = vi.fn();
    const releaseFailure = onComposerSubmitted(() => {
      throw new Error('history full');
    });
    const releaseAfter = onComposerSubmitted(afterFailure);

    expect(() =>
      publishComposerSubmission({
        sessionId: 's1',
        message: 'delivered',
        delivery: 'submit',
        submittedAt: 12,
        contextItems: [],
      }),
    ).not.toThrow();
    expect(afterFailure).toHaveBeenCalledOnce();
    releaseFailure();
    releaseAfter();
  });
});
