import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteFile, fetchFileDetail, saveFileContent, sessionFileUrl } from '../../src/web/filesApi.ts';

const SESSION = 's1';
const FILE = 'src/app.ts';
const CONFLICT = 409;
const SERVER_ERROR = 500;

const originalFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit | undefined }[];

/**
 * Stubs the global `fetch` the sealed transport passes through to.
 *
 * On loopback there is no channel, so a call routed through the transport
 * reaches the network exactly as a bare one would. That is what makes the
 * behaviour below identical either way, and why one test asserts the transport
 * is actually in the path rather than inferring it from these.
 */
function answers(status: number, body: unknown): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

function refuses(): void {
  calls = [];
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('sessionFileUrl', () => {
  it('points at the hub route that serves a session file, by its cwd-relative path', () => {
    expect(sessionFileUrl('s1', 'docs/report.pdf')).toBe('/api/sessions/s1/file?path=docs%2Freport.pdf');
  });

  it('encodes a path a URL would otherwise read as structure', () => {
    // A `#` truncates the request at the fragment and a `&` invents a second
    // parameter, so both have to survive as part of the name.
    const url = sessionFileUrl('s1', 'notes/draft #2 & final.png');
    expect(new URL(url, 'http://cockpit.local').searchParams.get('path')).toBe('notes/draft #2 & final.png');
  });

  it('encodes the session id too, since it lands in a path segment', () => {
    expect(sessionFileUrl('a/b', 'x.png')).toContain('/api/sessions/a%2Fb/file');
  });
});

describe('the transport', () => {
  it('routes through the sealed transport rather than calling fetch itself', async () => {
    // The behavioural tests below cannot show this: on loopback the transport
    // passes straight through, so a bare `fetch` would satisfy every one of
    // them while handing a tunnel relay the file contents in plaintext.
    const { sealedTransport } = await import('@agimon-ai/doompi-web-security/browser');
    const through = vi.spyOn(sealedTransport, 'fetch');
    answers(200, { path: FILE, edits: [] });
    await fetchFileDetail(SESSION, FILE);
    await saveFileContent(SESSION, FILE, 'before', 'next');
    await deleteFile(SESSION, FILE);
    expect(through).toHaveBeenCalledTimes(3);
    through.mockRestore();
  });
});

describe('reading a file detail', () => {
  it('asks the plugin route and hands back what it answered', async () => {
    answers(200, { path: FILE, edits: [] });
    const result = await fetchFileDetail(SESSION, FILE);
    expect(result).toEqual({ ok: true, detail: { path: FILE, edits: [] } });
    expect(calls[0]?.url).toContain(`path=${encodeURIComponent(FILE)}`);
  });

  it('reports an unreachable session rather than throwing at the caller', async () => {
    refuses();
    expect(await fetchFileDetail(SESSION, FILE)).toEqual({ ok: false, error: 'The session is unreachable.' });
  });

  it('prefers the reason the route gave over a status code', async () => {
    answers(SERVER_ERROR, { error: 'the file moved' });
    expect(await fetchFileDetail(SESSION, FILE)).toEqual({ ok: false, error: 'the file moved' });
  });

  it('falls back to the status when the route explained nothing', async () => {
    answers(SERVER_ERROR, undefined);
    const result = await fetchFileDetail(SESSION, FILE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('500');
  });

  it('refuses a 200 that carried no detail, rather than passing undefined on', async () => {
    answers(200, []);
    expect(await fetchFileDetail(SESSION, FILE)).toEqual({ ok: false, error: 'The session answered with no detail.' });
  });
});

describe('saving a file', () => {
  it('puts the path, the expected hash and the content, and returns the new hash', async () => {
    answers(200, { hash: 'after' });
    expect(await saveFileContent(SESSION, FILE, 'before', 'next')).toEqual({ ok: true, hash: 'after' });
    expect(calls[0]?.init?.method).toBe('PUT');
    const sent = calls[0]?.init?.body;
    expect(typeof sent).toBe('string');
    expect(JSON.parse(sent as string)).toEqual({
      path: FILE,
      expectedHash: 'before',
      content: 'next',
    });
  });

  it('reports a conflict as stale, carrying the hash the file holds now', async () => {
    // The editor needs that hash to offer a reload; without it the reader is
    // told the save failed and given no way to recover.
    answers(CONFLICT, { error: 'changed underneath', hash: 'theirs' });
    expect(await saveFileContent(SESSION, FILE, 'before', 'next')).toEqual({
      ok: false,
      stale: true,
      error: 'changed underneath',
      hash: 'theirs',
    });
  });

  it('is still stale when the conflict named no hash', async () => {
    answers(CONFLICT, {});
    const result = await saveFileContent(SESSION, FILE, 'before', 'next');
    expect(result).toMatchObject({ ok: false, stale: true });
    expect(result).not.toHaveProperty('hash');
  });

  it('separates a plain failure from a stale one, so the editor does not offer a reload', async () => {
    answers(SERVER_ERROR, { error: 'disk full' });
    expect(await saveFileContent(SESSION, FILE, 'before', 'next')).toEqual({
      ok: false,
      stale: false,
      error: 'disk full',
    });
  });

  it('reports an unreachable session as a plain failure', async () => {
    refuses();
    expect(await saveFileContent(SESSION, FILE, 'before', 'next')).toEqual({
      ok: false,
      stale: false,
      error: 'The session is unreachable.',
    });
  });

  it('accepts a success that named no hash rather than failing on it', async () => {
    answers(200, {});
    expect(await saveFileContent(SESSION, FILE, 'before', 'next')).toEqual({ ok: true, hash: '' });
  });
});

describe('deleting a file', () => {
  it('sends a DELETE to the content route', async () => {
    answers(200, undefined);
    expect(await deleteFile(SESSION, FILE)).toEqual({ ok: true });
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain(`path=${encodeURIComponent(FILE)}`);
  });

  it('reports the reason the route gave', async () => {
    answers(SERVER_ERROR, { error: 'permission denied' });
    expect(await deleteFile(SESSION, FILE)).toEqual({ ok: false, error: 'permission denied' });
  });

  it('reports an unreachable session', async () => {
    refuses();
    expect(await deleteFile(SESSION, FILE)).toEqual({ ok: false, error: 'The session is unreachable.' });
  });
});
