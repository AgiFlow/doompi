import { afterEach, describe, expect, it, vi } from 'vitest';
import { hubAnswers } from '../../src/adapters/hubProbe.ts';

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
