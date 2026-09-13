import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page's half of the runtime's context detail API.
 *
 * Every answer a reader can get from a click lands here: the detail itself, a
 * session that refuses with a reason, one that refuses without a body, and a
 * tunnel that never answers. The dialog shows whatever this returns, so a
 * swallowed failure reads as a spinner that never stops.
 */

const fetchMock = vi.fn();

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({
  sealedTransport: { fetch: (input: string, init?: RequestInit) => fetchMock(input, init) },
}));

const { fetchContextItemDetail } = await import('../../src/web/lib/contextDetailApi.ts');

function answer(status: number, body: string): Response {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('reading one context row', () => {
  // First, because the transport failure is the one answer that reaches the
  // dialog without a response at all.
  it('says the session did not answer when the tunnel throws', async () => {
    fetchMock.mockImplementation(() => {
      throw new Error('offline');
    });

    expect(await fetchContextItemDetail('s1', 'tool', 'read')).toEqual({
      ok: false,
      error: 'The session did not answer.',
    });
  });

  it('asks the session for the named row and returns the detail it sends', async () => {
    const item = { kind: 'tool', name: 'read', description: 'reads a file' };
    fetchMock.mockResolvedValue(answer(200, JSON.stringify({ item })));

    const result = await fetchContextItemDetail('s1', 'tool', 'read');

    expect(result).toEqual({ ok: true, detail: item });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('read');
  });

  it('reports the reason a session gives for refusing', async () => {
    fetchMock.mockResolvedValue(answer(404, JSON.stringify({ error: 'no such session' })));

    expect(await fetchContextItemDetail('s1', 'tool', 'read')).toEqual({ ok: false, error: 'no such session' });
  });

  it('names the status when the refusal carries no readable reason', async () => {
    fetchMock.mockResolvedValue(answer(500, 'not json'));

    expect(await fetchContextItemDetail('s1', 'skill', 'writing')).toEqual({
      ok: false,
      error: 'The session answered 500.',
    });
  });

  it('refuses an answer that carries no detail', async () => {
    fetchMock.mockResolvedValue(answer(200, JSON.stringify({ item: 'read' })));

    expect(await fetchContextItemDetail('s1', 'tool', 'read')).toEqual({
      ok: false,
      error: 'The session answered with no detail.',
    });
  });

  it('refuses an empty body the same way', async () => {
    fetchMock.mockResolvedValue(answer(200, ''));

    expect(await fetchContextItemDetail('s1', 'tool', 'read')).toEqual({
      ok: false,
      error: 'The session answered with no detail.',
    });
  });

  it('refuses a body that is not an object', async () => {
    fetchMock.mockResolvedValue(answer(200, '"read"'));

    expect(await fetchContextItemDetail('s1', 'tool', 'read')).toEqual({
      ok: false,
      error: 'The session answered with no detail.',
    });
  });
});
