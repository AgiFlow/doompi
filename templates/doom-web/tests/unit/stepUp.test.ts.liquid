import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithStepUp } from '../../src/web/lib/stepUp.ts';
import { STEP_UP_HEADER } from '../../src/types/remoteAccess.ts';

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

/** Stands in for the WebAuthn ceremony, which needs a real authenticator. */
const signs = async (): Promise<string> => 'an-assertion';
/** A user who dismissed the prompt. */
const declines = async (): Promise<undefined> => undefined;

describe('fetchWithStepUp', () => {
  it('passes a successful call straight through', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    const response = await fetchWithStepUp('/api/sessions', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(calls).toEqual(['/api/sessions']);
  });

  it('leaves an ordinary 401 alone when it names no action', async () => {
    // Not every refusal is a step-up; prompting for a gesture here would be
    // asking the user to authorise something the server never offered.
    globalThis.fetch = vi.fn(async () => new Response('{"error":"nope"}', { status: 401 })) as unknown as typeof fetch;
    expect((await fetchWithStepUp('/api/sessions')).status).toBe(401);
  });

  it('leaves a 401 with an unparseable body alone', async () => {
    globalThis.fetch = vi.fn(async () => new Response('not json', { status: 401 })) as unknown as typeof fetch;
    expect((await fetchWithStepUp('/api/sessions')).status).toBe(401);
  });

  it('does not retry when the gesture produces nothing', async () => {
    // A dismissed Face ID must fail the action rather than loop the prompt.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response('{"action":"session.create"}', { status: 401 });
    }) as unknown as typeof fetch;

    expect((await fetchWithStepUp('/api/sessions', undefined, declines)).status).toBe(401);
    expect(calls).toBe(1);
  });

  it('retries exactly once with the assertion attached', async () => {
    const attempts: (string | undefined)[] = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      attempts.push(new Headers(init?.headers).get(STEP_UP_HEADER) ?? undefined);
      return attempts.length === 1
        ? new Response('{"action":"session.create"}', { status: 401 })
        : new Response('{"ok":true}', { status: 201 });
    }) as unknown as typeof fetch;

    const response = await fetchWithStepUp('/api/sessions', { method: 'POST' }, signs);
    expect(response.status).toBe(201);
    expect(attempts).toEqual([undefined, 'an-assertion']);
  });

  it('stops after one retry, so a real refusal does not loop the prompt', async () => {
    let guarded = 0;
    globalThis.fetch = vi.fn(async () => {
      guarded += 1;
      return new Response('{"action":"session.create"}', { status: 401 });
    }) as unknown as typeof fetch;

    expect((await fetchWithStepUp('/api/sessions', undefined, signs)).status).toBe(401);
    expect(guarded).toBe(2);
  });

  it('keeps the original method and body on the retry', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(init?.body);
      return bodies.length === 1
        ? new Response('{"action":"session.create"}', { status: 401 })
        : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await fetchWithStepUp('/api/sessions', { method: 'POST', body: '{"cwd":"/tmp"}' }, signs);
    expect(bodies).toEqual(['{"cwd":"/tmp"}', '{"cwd":"/tmp"}']);
  });
});
