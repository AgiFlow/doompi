import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostHandshake } from '../../src/adapters/nodeSealedChannel.ts';
import { createSealedTransport } from '../../src/adapters/sealedTransport.ts';
import {
  SEALED_BODY_HEADER,
  describeSealedFailure,
  isSealedEnvelope,
  type SealedFailure,
} from '../../src/types/sealedChannel.ts';

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

async function connected() {
  const host = createHostHandshake();
  const transport = createSealedTransport();
  const clientKey = await transport.connect(host.publicKey);
  if (clientKey === undefined) throw new Error('no handshake');
  const server = host.accept(clientKey);
  if (server === undefined) throw new Error('host refused');
  return { transport, server };
}

describe('sealed fetch', () => {
  it('is a plain fetch when there is no channel', async () => {
    const transport = createSealedTransport();
    const seen: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;

    await transport.fetch('/api/thing', { method: 'POST', body: '{"a":1}' });
    expect(seen[0]?.body).toBe('{"a":1}');
    expect(new Headers(seen[0]?.headers).get(SEALED_BODY_HEADER)).toBeNull();
  });

  it('seals the request body and marks it, so a handler never has to guess', async () => {
    const { transport, server } = await connected();
    let sentBody = '';
    let sentHeaders = new Headers();
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sentBody = typeof init?.body === 'string' ? init.body : '';
      sentHeaders = new Headers(init?.headers);
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;

    await transport.fetch('/api/thing', { method: 'POST', body: '{"secret":"prompt text"}' });
    expect(sentBody).not.toContain('prompt text');
    expect(sentHeaders.get(SEALED_BODY_HEADER)).toBe('1');
    expect(isSealedEnvelope(JSON.parse(sentBody))).toBe(true);
    const opened = server.open(JSON.parse(sentBody));
    expect(opened.ok && new TextDecoder().decode(opened.plaintext)).toBe('{"secret":"prompt text"}');
  });

  it('opens a sealed response', async () => {
    const { transport, server } = await connected();
    globalThis.fetch = vi.fn(async () => {
      const sealed = server.seal(new TextEncoder().encode('{"answer":42}'));
      if (!sealed.ok) throw new Error(sealed.failure);
      return new Response(JSON.stringify(sealed.envelope), { headers: { [SEALED_BODY_HEADER]: '1' } });
    }) as unknown as typeof fetch;

    const response = await transport.fetch('/api/thing');
    await expect(response.json()).resolves.toEqual({ answer: 42 });
  });

  it('leaves an unsealed response alone, so plaintext routes still work', async () => {
    const { transport } = await connected();
    globalThis.fetch = vi.fn(async () => new Response('{"plain":true}')) as unknown as typeof fetch;
    await expect((await transport.fetch('/api/thing')).json()).resolves.toEqual({ plain: true });
  });

  it('reports a response it cannot open rather than handing back ciphertext', async () => {
    const { transport } = await connected();
    globalThis.fetch = vi.fn(
      async () => new Response('{"v":1,"n":"AAAA","c":"AAAA"}', { headers: { [SEALED_BODY_HEADER]: '1' } }),
    ) as unknown as typeof fetch;

    const response = await transport.fetch('/api/thing');
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain('shaped');
  });

  it('passes a body it cannot seal through untouched rather than dropping the call', async () => {
    // A FormData or stream body is not a string; sealing it is out of scope and
    // silently dropping the request would be worse than sending it as it was.
    const { transport } = await connected();
    let sentHeaders = new Headers();
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response('{}');
    }) as unknown as typeof fetch;

    await transport.fetch('/api/thing', { method: 'POST', body: new URLSearchParams({ a: '1' }) });
    expect(sentHeaders.get(SEALED_BODY_HEADER)).toBeNull();
  });
});

describe('openBinary', () => {
  it('round-trips bytes from the host half', async () => {
    const { transport, server } = await connected();
    const sealed = server.seal(new Uint8Array([9, 8, 7]));
    if (!sealed.ok) throw new Error(sealed.failure);
    const opened = await transport.openBinary(new TextEncoder().encode(JSON.stringify(sealed.envelope)));
    expect(opened === undefined ? undefined : Array.from(opened)).toEqual([9, 8, 7]);
  });

  it('passes bytes through when there is no channel', async () => {
    const transport = createSealedTransport();
    const payload = new Uint8Array([1, 2, 3]);
    await expect(transport.openBinary(payload)).resolves.toBe(payload);
  });
});

describe('describeSealedFailure', () => {
  it('has plain words for every failure, because a blank page needs a cause', () => {
    const failures: SealedFailure[] = ['version', 'malformed', 'replay', 'auth', 'exhausted'];
    for (const failure of failures) {
      expect(describeSealedFailure(failure).length).toBeGreaterThan(10);
    }
    expect(describeSealedFailure('auth')).toContain('altered');
    expect(describeSealedFailure('replay')).toContain('twice');
  });
});

describe('isSealedEnvelope', () => {
  it.each([
    [{ v: 1, n: 'a', c: 'b' }, true],
    [{ v: 2, n: 'a', c: 'b' }, false],
    [{ v: 1, n: 'a' }, false],
    [{ v: 1, n: 1, c: 'b' }, false],
    [null, false],
    ['nope', false],
  ])('reads %j as %s', (value, expected) => {
    expect(isSealedEnvelope(value)).toBe(expected);
  });
});
