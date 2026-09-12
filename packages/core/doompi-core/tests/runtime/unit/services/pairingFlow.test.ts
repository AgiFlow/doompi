import { describe, expect, it, vi } from 'vitest';
import { createPairingFlow } from '../../../../src/services/pairingFlow';
import { PAIRING_CODE_TTL_MS, PAIRING_REQUEST_TTL_MS } from '../../../../src/constants/remote';

function fixture() {
  let time = 1000;
  let sequence = 0;
  const notice = vi.fn();
  const flow = createPairingFlow({
    randomToken: () => `token-${++sequence}`,
    randomManualCode: () => '123456',
    digest: (value) => `hash:${value}`,
    now: () => time,
    onNotice: notice,
  });
  return {
    flow,
    notice,
    setTime: (value: number) => {
      time = value;
    },
  };
}

const claim = (code: string, sourceAddress = '192.0.2.1') => ({
  code,
  userAgent: 'Phone',
  edgeIp: '192.0.2.2',
  sourceAddress,
});

describe('pairing flow', () => {
  it('accepts either code exactly once and requires approval before consumption', () => {
    const { flow, notice } = fixture();
    const codes = flow.mintCode();
    expect(codes).toEqual({ code: 'token-1', manualCode: '123456', expiresAt: 1000 + PAIRING_CODE_TTL_MS });
    const outcome = flow.claim(claim(codes.manualCode));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected pairing request');
    expect(flow.claim(claim(codes.code))).toEqual({ ok: false, code: 'unknown_code' });
    expect(flow.status(outcome.requestId)).toBe('pending');
    expect(flow.pending()).toMatchObject([{ id: outcome.requestId, status: 'pending' }]);
    expect(flow.consume(outcome.requestId)).toBeUndefined();
    expect(flow.approve(outcome.requestId)).toBe('approved');
    expect(flow.approve(outcome.requestId)).toBe('settled');
    expect(flow.pending()).toEqual([]);
    expect(flow.consume(outcome.requestId)).toEqual({ userAgent: 'Phone' });
    expect(flow.consume(outcome.requestId)).toBeUndefined();
    expect(flow.status(outcome.requestId)).toBe('consumed');
    expect(notice).toHaveBeenCalledWith('pairing approved for Phone');
  });

  it('retire old codes on mint and expiry, and expires pending requests', () => {
    const { flow, setTime } = fixture();
    const old = flow.mintCode();
    const current = flow.mintCode();
    expect(flow.claim(claim(old.code))).toEqual({ ok: false, code: 'unknown_code' });
    const outcome = flow.claim(claim(current.code));
    if (!outcome.ok) throw new Error('expected pairing request');
    setTime(1000 + PAIRING_REQUEST_TTL_MS);
    expect(flow.status(outcome.requestId)).toBe('expired');
    expect(flow.pending()).toEqual([]);
    expect(flow.approve(outcome.requestId)).toBe('expired');
    expect(flow.deny(outcome.requestId)).toBe('denied');
    expect(flow.status(outcome.requestId)).toBe('denied');
    expect(flow.deny(outcome.requestId)).toBe('settled');
    expect(flow.consume(outcome.requestId)).toBeUndefined();
    const expired = flow.mintCode();
    setTime(1000 + PAIRING_REQUEST_TTL_MS + PAIRING_CODE_TTL_MS);
    expect(flow.claim(claim(expired.code))).toEqual({ ok: false, code: 'unknown_code' });
  });

  it('throttles failed claims per source, resets the window, and reports abuse once', () => {
    const { flow, notice, setTime } = fixture();
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(flow.claim(claim('wrong'))).toEqual({ ok: false, code: 'unknown_code' });
    }
    expect(flow.claim(claim('wrong'))).toEqual({ ok: false, code: 'rate_limited' });
    expect(flow.claim(claim('wrong'))).toEqual({ ok: false, code: 'rate_limited' });
    expect(notice).toHaveBeenCalledTimes(1);
    expect(flow.claim(claim('wrong', 'other'))).toEqual({ ok: false, code: 'unknown_code' });
    setTime(61_000);
    expect(flow.claim(claim('wrong'))).toEqual({ ok: false, code: 'unknown_code' });
  });

  it('sweeps retained requests and expired codes, then clears all state', () => {
    const { flow, setTime } = fixture();
    expect(flow.status('missing')).toBeUndefined();
    expect(flow.approve('missing')).toBe('unknown');
    expect(flow.deny('missing')).toBe('unknown');
    expect(flow.consume('missing')).toBeUndefined();
    const { code } = flow.mintCode();
    const outcome = flow.claim(claim(code));
    if (!outcome.ok) throw new Error('expected pairing request');
    expect(flow.deny(outcome.requestId)).toBe('denied');
    setTime(1000 + PAIRING_REQUEST_TTL_MS * 2);
    flow.sweep();
    expect(flow.status(outcome.requestId)).toBeUndefined();
    const next = flow.mintCode();
    flow.clear();
    expect(flow.claim(claim(next.code))).toEqual({ ok: false, code: 'unknown_code' });
    expect(flow.pending()).toEqual([]);
  });
});
