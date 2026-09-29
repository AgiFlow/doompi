import { describe, expect, it } from 'vitest';

import { createKeySender } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/keySender';

/** A send whose requests settle only when the test releases them, in any order it likes. */
function deferredSend() {
  const sent: string[] = [];
  const pending: Array<(accepted: boolean) => void> = [];
  const send = (data: string): Promise<boolean> => {
    sent.push(data);
    return new Promise((resolve) => pending.push(resolve));
  };
  const settleNext = async (accepted = true): Promise<void> => {
    pending.shift()?.(accepted);
    // Let the sender's loop pick up the next batch.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { sent, send, settleNext, inFlight: () => pending.length };
}

describe('createKeySender', () => {
  it('keeps one request in flight and sends quickly typed keys in order', async () => {
    const test = deferredSend();
    const type = createKeySender(test.send);

    for (const key of 'e2e-word') type(key);

    expect(test.sent).toEqual(['e']);
    expect(test.inFlight()).toBe(1);
    await test.settleNext();
    expect(test.sent).toEqual(['e', '2e-word']);
    await test.settleNext();
    expect(test.sent.join('')).toBe('e2e-word');
    expect(test.inFlight()).toBe(0);
  });

  it('drops what is queued once the run refuses the keys', async () => {
    const test = deferredSend();
    const type = createKeySender(test.send);

    type('a');
    type('b');
    await test.settleNext(false);

    expect(test.sent).toEqual(['a']);
    type('c');
    expect(test.sent).toEqual(['a', 'c']);
  });
});
