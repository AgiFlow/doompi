import { beforeEach, describe, expect, it } from 'vitest';
import { type PairingFlow, createPairingFlow } from '../../src/services/pairingFlow.ts';
import { PAIRING_CODE_TTL_MS, PAIRING_REQUEST_TTL_MS } from '../../src/types/remoteAccess.ts';

const START = 1_700_000_000_000;
const AGENT = 'Mozilla/5.0 (iPhone) Safari/604.1';

let now: number;
let issued: number;
let notices: string[];
let flow: PairingFlow;

beforeEach(() => {
  now = START;
  issued = 0;
  notices = [];
  flow = createPairingFlow({
    // A counter rather than randomness, so a test can name the token it expects.
    randomToken: () => {
      issued += 1;
      return `token-${String(issued)}`;
    },
    digest: (token) => `sha:${token}`,
    now: () => now,
    onNotice: (message) => notices.push(message),
  });
});

function claim(code: string, sourceAddress = '127.0.0.1'): ReturnType<PairingFlow['claim']> {
  return flow.claim({ code, userAgent: AGENT, edgeIp: '203.0.113.7', sourceAddress });
}

describe('the pairing handshake', () => {
  it('takes a scanned code to a request the host must answer', () => {
    const { code } = flow.mintCode();
    const claimed = claim(code);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    // Crucially still pending: scanning alone does not pair anything.
    expect(flow.status(claimed.requestId)).toBe('pending');
    expect(flow.pending()).toHaveLength(1);
  });

  it('mints nothing until the host approves, then exactly once', () => {
    const { code } = flow.mintCode();
    const claimed = claim(code);
    if (!claimed.ok) throw new Error('claim failed');
    expect(flow.consume(claimed.requestId)).toBeUndefined();
    expect(flow.approve(claimed.requestId)).toBe('approved');
    expect(flow.consume(claimed.requestId)).toEqual({ userAgent: AGENT });
    // Single use with no grace window: a second collection gets nothing.
    expect(flow.consume(claimed.requestId)).toBeUndefined();
    expect(flow.status(claimed.requestId)).toBe('consumed');
  });

  it('reports a denial to the phone rather than going silent', () => {
    const { code } = flow.mintCode();
    const claimed = claim(code);
    if (!claimed.ok) throw new Error('claim failed');
    expect(flow.deny(claimed.requestId)).toBe('denied');
    expect(flow.status(claimed.requestId)).toBe('denied');
    expect(flow.consume(claimed.requestId)).toBeUndefined();
  });

  it('drops the request from the host prompt once it is answered', () => {
    const { code } = flow.mintCode();
    const claimed = claim(code);
    if (!claimed.ok) throw new Error('claim failed');
    flow.approve(claimed.requestId);
    expect(flow.pending()).toHaveLength(0);
  });
});

describe('pairing expiry', () => {
  it('refuses a code past its window', () => {
    const { code } = flow.mintCode();
    now += PAIRING_CODE_TTL_MS;
    expect(claim(code)).toEqual({ ok: false, code: 'unknown_code' });
  });

  it('refuses a replayed code, because the first claim consumes it', () => {
    const { code } = flow.mintCode();
    expect(claim(code).ok).toBe(true);
    expect(claim(code)).toEqual({ ok: false, code: 'unknown_code' });
  });

  it('retires the previous code when a new one is minted', () => {
    const first = flow.mintCode();
    flow.mintCode();
    expect(claim(first.code)).toEqual({ ok: false, code: 'unknown_code' });
  });

  it('expires a request the host never answered', () => {
    const { code } = flow.mintCode();
    const claimed = claim(code);
    if (!claimed.ok) throw new Error('claim failed');
    now += PAIRING_REQUEST_TTL_MS;
    expect(flow.status(claimed.requestId)).toBe('expired');
    expect(flow.pending()).toHaveLength(0);
  });

  it('refuses to approve an expired request', () => {
    const { code } = flow.mintCode();
    const claimed = claim(code);
    if (!claimed.ok) throw new Error('claim failed');
    now += PAIRING_REQUEST_TTL_MS;
    expect(flow.approve(claimed.requestId)).toBe('expired');
    expect(flow.consume(claimed.requestId)).toBeUndefined();
  });

  it('keeps an approval collectable past the pending window', () => {
    // A host approving in the last second still has to reach the phone's poll.
    const { code } = flow.mintCode();
    const claimed = claim(code);
    if (!claimed.ok) throw new Error('claim failed');
    flow.approve(claimed.requestId);
    now += PAIRING_REQUEST_TTL_MS + 1000;
    flow.sweep();
    expect(flow.consume(claimed.requestId)).toEqual({ userAgent: AGENT });
  });

  it('eventually reclaims a settled request', () => {
    const { code } = flow.mintCode();
    const claimed = claim(code);
    if (!claimed.ok) throw new Error('claim failed');
    flow.deny(claimed.requestId);
    now += PAIRING_REQUEST_TTL_MS * 2;
    flow.sweep();
    expect(flow.status(claimed.requestId)).toBeUndefined();
  });
});

describe('brute force', () => {
  it('starts refusing after a burst of wrong codes', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(claim('wrong')).toEqual({ ok: false, code: 'unknown_code' });
    }
    expect(claim('wrong')).toEqual({ ok: false, code: 'rate_limited' });
  });

  it('forgives the burst once the window rolls', () => {
    for (let attempt = 0; attempt < 11; attempt += 1) claim('wrong');
    now += 61_000;
    expect(claim('wrong')).toEqual({ ok: false, code: 'unknown_code' });
  });

  it('limits each normalized source independently and warns once when abuse starts', () => {
    for (let attempt = 0; attempt < 11; attempt += 1) claim('wrong', 'cloudflare:203.0.113.1');

    expect(claim('wrong', 'cloudflare:203.0.113.1')).toEqual({ ok: false, code: 'rate_limited' });
    expect(claim('wrong', 'cloudflare:203.0.113.2')).toEqual({ ok: false, code: 'unknown_code' });
    expect(notices.filter((message) => message.includes('pairing claim abuse detected'))).toEqual([
      'pairing claim abuse detected from cloudflare:203.0.113.1; throttling invalid attempts',
    ]);
  });
});

describe('what the host is told', () => {
  it('sanitizes the user agent and edge address before they reach a notice', () => {
    const { code } = flow.mintCode();
    flow.claim({
      code,
      userAgent: 'Evil/1.0\r\n[doompi-web] approved',
      edgeIp: 'not-an-address',
      sourceAddress: '127.0.0.1',
    });
    expect(notices[0]).toBe('pairing requested from Evil/1.0 [doompi-web] approved via unknown');
    expect(notices[0]).not.toContain('\n');
  });

  it('reports nothing for a request id it never issued', () => {
    expect(flow.status('never-existed')).toBeUndefined();
    expect(flow.approve('never-existed')).toBe('unknown');
    expect(flow.deny('never-existed')).toBe('unknown');
    expect(flow.consume('never-existed')).toBeUndefined();
  });

  it('refuses to settle a request twice', () => {
    const { code } = flow.mintCode();
    const claimed = claim(code);
    if (!claimed.ok) throw new Error('claim failed');
    flow.approve(claimed.requestId);
    expect(flow.approve(claimed.requestId)).toBe('settled');
    expect(flow.deny(claimed.requestId)).toBe('settled');
  });

  it('sweeps a code that aged out without ever being claimed', () => {
    flow.mintCode();
    now += PAIRING_CODE_TTL_MS;
    flow.sweep();
    expect(claim('anything')).toEqual({ ok: false, code: 'unknown_code' });
  });

  it('forgets everything when remote access is switched off', () => {
    const { code } = flow.mintCode();
    const claimed = claim(code);
    if (!claimed.ok) throw new Error('claim failed');
    flow.clear();
    expect(flow.status(claimed.requestId)).toBeUndefined();
    expect(flow.pending()).toHaveLength(0);
  });
});
