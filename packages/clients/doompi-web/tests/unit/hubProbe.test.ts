import { afterEach, describe, expect, it, vi } from 'vitest';
import { hubAnswers, probeHub } from '../../src/adapters/hubProbe.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hub probe', () => {
  it('recognizes a healthy cockpit hub', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, role: 'hub' }));
    vi.stubGlobal('fetch', fetch);

    await expect(hubAnswers('127.0.0.1', 43120)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:43120/api/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
    );
  });

  it('rejects an unhealthy response before reading its body', async () => {
    const json = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json })),
    );

    await expect(hubAnswers('localhost', 43120)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, role: 'hub' }, 'a failed health result'],
    [{ ok: true, role: 'session' }, 'a non-hub role'],
  ])('rejects %s', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body)),
    );

    await expect(hubAnswers('localhost', 43120)).resolves.toBe(false);
  });

  it.each([
    [() => Promise.reject(new Error('connection refused')), 'a connection error'],
    [() => Promise.resolve(new Response('not json')), 'an invalid response body'],
  ])('treats %s as an unanswered probe', async (fetch) => {
    vi.stubGlobal('fetch', vi.fn(fetch));

    await expect(hubAnswers('localhost', 43120)).resolves.toBe(false);
  });
});

describe('what the probe reports about the hub it found', () => {
  it('carries the version, pid and live session count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, role: 'hub', version: '1.2.3', pid: 4321, sessions: 2 })),
    );

    await expect(probeHub('127.0.0.1', 43120)).resolves.toEqual({ version: '1.2.3', pid: 4321, sessions: 2 });
  });

  it('reports no hub when the role is wrong, so an unrelated server is never signalled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, role: 'something-else', pid: 4321 })),
    );

    await expect(probeHub('127.0.0.1', 43120)).resolves.toBeUndefined();
  });

  it('omits a version an older hub does not publish', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, role: 'hub', pid: 12 })),
    );

    await expect(probeHub('127.0.0.1', 43120)).resolves.toEqual({ pid: 12, sessions: 0 });
  });

  it.each([
    ['a missing pid', { ok: true, role: 'hub', version: '1.0.0' }],
    ['a zero pid', { ok: true, role: 'hub', version: '1.0.0', pid: 0 }],
    ['a negative pid', { ok: true, role: 'hub', version: '1.0.0', pid: -1 }],
    ['a fractional pid', { ok: true, role: 'hub', version: '1.0.0', pid: 1.5 }],
  ])('drops %s rather than signalling it', async (_label, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body)),
    );

    await expect(probeHub('127.0.0.1', 43120)).resolves.toEqual({ version: '1.0.0', sessions: 0 });
  });

  it('treats an absent or nonsensical session count as no live sessions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, role: 'hub', version: '1.0.0', sessions: 'many' })),
    );

    await expect(probeHub('127.0.0.1', 43120)).resolves.toEqual({ version: '1.0.0', sessions: 0 });
  });
});
