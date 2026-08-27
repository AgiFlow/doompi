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

  it('seals the complete request, so the relay sees neither target nor body', async () => {
    const { transport, server } = await connected();
    transport.relayRequestsThrough('/api/remote/request');
    let sentBody = '';
    let sentTarget: unknown;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      sentTarget = input;
      sentBody = typeof init?.body === 'string' ? init.body : '';
      const opened = server.open(JSON.parse(sentBody));
      if (!opened.ok) throw new Error(opened.failure);
      expect(JSON.parse(new TextDecoder().decode(opened.plaintext))).toMatchObject({
        method: 'POST',
        target: '/api/thing',
      });
      const response = server.seal(
        new TextEncoder().encode(JSON.stringify({ v: 1, status: 200, headers: [], body: btoa('{}') })),
      );
      if (!response.ok) throw new Error(response.failure);
      return new Response(JSON.stringify(response.envelope));
    }) as unknown as typeof fetch;

    await transport.fetch('/api/thing', { method: 'POST', body: '{"secret":"prompt text"}' });
    expect(sentTarget).toBe('/api/remote/request');
    expect(sentBody).not.toContain('prompt text');
    expect(sentBody).not.toContain('/api/thing');
    expect(isSealedEnvelope(JSON.parse(sentBody))).toBe(true);
  });

  it('opens a sealed response', async () => {
    const { transport, server } = await connected();
    transport.relayRequestsThrough('/api/remote/request');
    globalThis.fetch = vi.fn(async () => {
      const sealed = server.seal(
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            status: 200,
            headers: [['content-type', 'application/json']],
            body: btoa('{"answer":42}'),
          }),
        ),
      );
      if (!sealed.ok) throw new Error(sealed.failure);
      return new Response(JSON.stringify(sealed.envelope));
    }) as unknown as typeof fetch;

    const response = await transport.fetch('/api/thing');
    await expect(response.json()).resolves.toEqual({ answer: 42 });
  });

  it('refuses an unsealed response once the HTTP channel is active', async () => {
    const { transport } = await connected();
    transport.relayRequestsThrough('/api/remote/request');
    globalThis.fetch = vi.fn(async () => new Response('{"plain":true}')) as unknown as typeof fetch;

    const response = await transport.fetch('/api/thing');
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain('shaped');
  });

  it('reports a response it cannot open rather than handing back ciphertext', async () => {
    const { transport } = await connected();
    transport.relayRequestsThrough('/api/remote/request');
    globalThis.fetch = vi.fn(async () => new Response('{"v":1,"n":"AAAA","c":"AAAA"}')) as unknown as typeof fetch;

    const response = await transport.fetch('/api/thing');
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain('shaped');
  });

  it('seals URL-encoded bodies instead of falling back to plaintext', async () => {
    const { transport, server } = await connected();
    transport.relayRequestsThrough('/api/remote/request');
    let sentBody = '';
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sentBody = typeof init?.body === 'string' ? init.body : '';
      const opened = server.open(JSON.parse(sentBody));
      if (!opened.ok) throw new Error(opened.failure);
      const request = JSON.parse(new TextDecoder().decode(opened.plaintext)) as { body: string };
      expect(atob(request.body)).toBe('a=1');
      const response = server.seal(
        new TextEncoder().encode(JSON.stringify({ v: 1, status: 200, headers: [], body: btoa('{}') })),
      );
      if (!response.ok) throw new Error(response.failure);
      return new Response(JSON.stringify(response.envelope));
    }) as unknown as typeof fetch;

    await transport.fetch('/api/thing', { method: 'POST', body: new URLSearchParams({ a: '1' }) });
    expect(sentBody).not.toContain('a=1');
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
