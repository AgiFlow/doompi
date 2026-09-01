import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentUrl, currentUrl } from '../src/types/planApi.ts';
import { fetchPlan, savePlan } from '../src/web/planApi.ts';

/**
 * The page's half of the session API.
 *
 * Every branch here is a way the session can answer that is not a plan, and
 * the panel shows whatever this returns verbatim. A status folded into the
 * wrong result shape is how a reader ends up told "the session is unreachable"
 * about a plan that was merely never written, or, worse, how a stale save is
 * reported as an ordinary failure and the reader retries into a clobber.
 */

const realFetch = globalThis.fetch;

function answering(status: number, body?: unknown): void {
  globalThis.fetch = vi.fn(async () =>
    Promise.resolve(new Response(body === undefined ? '' : JSON.stringify(body), { status })),
  ) as typeof globalThis.fetch;
}

function refusing(): void {
  globalThis.fetch = vi.fn(async () => Promise.reject(new Error('offline'))) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('reading the plan from the page', () => {
  it('asks the session route, through the hub, with the session in the query', async () => {
    answering(200, { path: '/plans/one.md', title: 'one', content: '# one', hash: 'h', unavailable: false });

    await fetchPlan('s1');

    expect(globalThis.fetch).toHaveBeenCalledWith(currentUrl('s1'));
  });

  it('answers the plan the session sent', async () => {
    answering(200, { path: '/plans/one.md', title: 'one', content: '# one', hash: 'h', unavailable: false });

    const result = await fetchPlan('s1');

    expect(result).toMatchObject({ ok: true, detail: { title: 'one', content: '# one', hash: 'h' } });
  });

  it('reports a session that has written no plan as exactly that', async () => {
    answering(404, { error: 'This session has not written a plan yet.' });

    expect(await fetchPlan('s1')).toEqual({ ok: false, error: 'This session has not written a plan yet.' });
  });

  it('reports a session that is not there as unreachable, not as an empty plan', async () => {
    refusing();

    expect(await fetchPlan('s1')).toEqual({ ok: false, error: 'The session is unreachable.' });
  });

  it('never reports an empty message, whatever the session answered', async () => {
    answering(500);

    const result = await fetchPlan('s1');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('500');
  });
});

describe('saving the plan from the page', () => {
  it('puts the edit with the hash it was read at', async () => {
    answering(200, { hash: 'next' });

    const result = await savePlan('s1', 'held', '# edited');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      contentUrl('s1'),
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ expectedHash: 'held', content: '# edited' }) }),
    );
    expect(result).toEqual({ ok: true, hash: 'next' });
  });

  it('reports a refused save as stale, carrying the hash the plan now holds', async () => {
    // The panel needs to tell this apart from an ordinary failure: only here
    // does retrying the same body overwrite whatever the agent just wrote.
    answering(409, { error: 'The plan changed since it was opened.', hash: 'theirs' });

    expect(await savePlan('s1', 'held', '# edited')).toEqual({
      ok: false,
      stale: true,
      error: 'The plan changed since it was opened.',
      hash: 'theirs',
    });
  });

  it('reports a stale save even when the session named no hash', async () => {
    answering(409, { error: 'the plan file no longer exists' });

    expect(await savePlan('s1', 'held', '# edited')).toEqual({
      ok: false,
      stale: true,
      error: 'the plan file no longer exists',
    });
  });

  it('reports an ordinary refusal as not stale, so the panel does not offer a retry', async () => {
    answering(400, { error: 'A save carries the content to write and the hash it was read at.' });

    expect(await savePlan('s1', 'held', '# edited')).toMatchObject({ ok: false, stale: false });
  });

  it('reports an unreachable session rather than throwing into the click handler', async () => {
    refusing();

    expect(await savePlan('s1', 'held', '# edited')).toEqual({
      ok: false,
      stale: false,
      error: 'The session is unreachable.',
    });
  });
});
