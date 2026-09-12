import { describe, expect, it, vi } from 'vitest';
import { RealtimeDelivery } from '../src/controllers/realtimeDelivery';

function fixture() {
  let owned = true;
  let busy = false;
  let blocked = false;
  const send = vi.fn();
  const delivery = new RealtimeDelivery({
    activationId: 'activation-1',
    isOwned: (activationId) => owned && activationId === 'activation-1',
    isBusy: () => busy,
    isBlocked: () => blocked,
    send,
  });
  return {
    delivery,
    send,
    setOwned: (value: boolean) => (owned = value),
    setBusy: (value: boolean) => (busy = value),
    setBlocked: (value: boolean) => (blocked = value),
  };
}

const request = { requestId: 'request-1', text: 'Companion reformulation' };

describe('RealtimeDelivery', () => {
  it('waits for a fresh finalized user transcript when delegation arrives first', () => {
    const { delivery, send } = fixture();
    delivery.observe({ type: 'request', ...request });

    expect(delivery.submit(request)).toBe('busy');
    delivery.observe({ type: 'transcript', role: 'assistant', text: 'Sure, doing that.', complete: true });
    delivery.observe({ type: 'transcript', role: 'user', text: 'Run the voice tests', complete: false });
    expect(delivery.submit(request)).toBe('busy');

    delivery.observe({ type: 'transcript', role: 'user', text: 'Run the voice tests', complete: true });
    expect(delivery.submit(request)).toBe('submitted');
    expect(send).toHaveBeenCalledWith('Run the voice tests', 'immediate');
    expect(send).not.toHaveBeenCalledWith('Companion reformulation', expect.anything());
  });

  it('supports source ordering with finalized user text before delegation and consumes it once', () => {
    const { delivery, send } = fixture();
    delivery.observe({ type: 'transcript', role: 'user', text: 'Use my exact words', complete: true });
    delivery.observe({ type: 'request', ...request });

    expect(delivery.submit(request)).toBe('submitted');
    delivery.observe({ type: 'request', requestId: 'request-2', text: 'Second reformulation' });
    expect(delivery.submit({ requestId: 'request-2', text: 'Second reformulation' })).toBe('busy');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retains duplicate outcomes, rejects changed payloads, and never implicitly replays', () => {
    const { delivery, send } = fixture();
    delivery.observe({ type: 'request', ...request });
    delivery.observe({ type: 'transcript', role: 'user', text: 'Authoritative user intent', complete: true });

    expect(delivery.submit(request)).toBe('submitted');
    expect(delivery.submit(request)).toBe('submitted');
    expect(delivery.submit({ ...request, text: 'Changed' })).toBe('rejected');
    expect(send).toHaveBeenCalledOnce();
  });

  it('steers immediately while busy and fails closed while ask-user is blocked', () => {
    const first = fixture();
    first.setBusy(true);
    first.delivery.observe({ type: 'request', ...request });
    first.delivery.observe({ type: 'transcript', role: 'user', text: 'Start another task', complete: true });
    expect(first.delivery.submit(request)).toBe('submitted');
    expect(first.send).toHaveBeenCalledWith('Start another task', 'immediate');

    const second = fixture();
    second.setBusy(true);
    second.setBlocked(true);
    second.delivery.observe({ type: 'request', ...request });
    second.delivery.observe({ type: 'transcript', role: 'user', text: 'Yes, choose the first option', complete: true });
    expect(second.delivery.submit(request)).toBe('rejected');
    expect(second.send).not.toHaveBeenCalled();
  });

  it('fails closed without ownership and reports uncertain delivery without replay', () => {
    const lost = fixture();
    lost.delivery.observe({ type: 'request', ...request });
    lost.delivery.observe({ type: 'transcript', role: 'user', text: 'Do the work', complete: true });
    lost.setOwned(false);
    expect(lost.delivery.submit(request)).toBe('rejected');
    expect(lost.send).not.toHaveBeenCalled();

    const uncertain = fixture();
    uncertain.send.mockImplementation(() => {
      throw new Error('unknown delivery state');
    });
    uncertain.delivery.observe({ type: 'request', ...request });
    uncertain.delivery.observe({ type: 'transcript', role: 'user', text: 'Do the work', complete: true });
    expect(uncertain.delivery.submit(request)).toBe('uncertain');
    expect(uncertain.delivery.submit(request)).toBe('uncertain');
    expect(uncertain.send).toHaveBeenCalledOnce();
  });

  it('keeps the sole pending request while classifying competing requests', () => {
    const { delivery, send } = fixture();
    delivery.observe({ type: 'request', ...request });

    const second = { requestId: 'request-2', text: 'Second reformulation' };
    delivery.observe({ type: 'request', ...second });
    expect(delivery.submit(second)).toBe('busy');
    expect(delivery.submit({ ...request, text: 'Changed identity' })).toBe('rejected');
    expect(delivery.submit(request)).toBe('busy');

    delivery.observe({ type: 'transcript', role: 'user', text: 'Original user request', complete: true });
    expect(delivery.submit(request)).toBe('submitted');
    expect(send).toHaveBeenCalledOnce();
  });

  it('retires a request awaiting transcript and does not authorize it from a later utterance', () => {
    const { delivery, send } = fixture();
    delivery.observe({ type: 'request', ...request });

    expect(delivery.retire(request)).toBe('rejected');
    delivery.observe({ type: 'transcript', role: 'user', text: 'A later unrelated utterance', complete: true });
    expect(delivery.submit(request)).toBe('rejected');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects retirement unless the exact pending identity matches', () => {
    const { delivery } = fixture();
    delivery.observe({ type: 'request', ...request });

    expect(delivery.retire({ ...request, text: 'Changed identity' })).toBe('rejected');
    expect(delivery.submit(request)).toBe('busy');
  });

  it('never treats assistant acknowledgments or companion request text as question approval', () => {
    const { delivery, send, setBlocked } = fixture();
    setBlocked(true);
    delivery.observe({ type: 'request', ...request });
    delivery.observe({ type: 'transcript', role: 'assistant', text: 'Yes', complete: true });

    expect(delivery.submit(request)).toBe('busy');
    expect(send).not.toHaveBeenCalled();
  });
});
