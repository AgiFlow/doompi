import { describe, expect, it, vi } from 'vitest';
import { createHostHandshake } from '../../src/adapters/nodeSealedChannel.ts';
import { createSealedTransport } from '../../src/adapters/sealedTransport.ts';
import { createSerialQueue } from '../../src/services/serialQueue.ts';

/** Brings up both halves of a channel over one handshake. */
async function pair() {
  const host = createHostHandshake();
  const transport = createSealedTransport();
  const clientKey = await transport.connect(host.publicKey);
  if (clientKey === undefined) throw new Error('the browser refused the handshake');
  const server = host.accept(clientKey);
  if (server === undefined) throw new Error('the host refused the browser key');
  return { transport, server };
}

describe('createSerialQueue', () => {
  it('finishes tasks in the order they were handed over, whatever their duration', async () => {
    // The whole reason this exists: sealing advances a counter and opening
    // demands it strictly increase, so overlapping work is a correctness bug
    // rather than a race worth tolerating.
    const finished: number[] = [];
    const queue = createSerialQueue();
    const delays = [30, 1, 20, 2, 10];
    await Promise.all(
      delays.map((delay, index) =>
        queue.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          finished.push(index);
        }),
      ),
    );
    expect(finished).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps running after a task rejects', async () => {
    const queue = createSerialQueue();
    await expect(
      queue.run(async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await expect(queue.run(async () => 'still here')).resolves.toBe('still here');
  });

  it('gives each task its own result', async () => {
    const queue = createSerialQueue();
    await expect(Promise.all([1, 2, 3].map((value) => queue.run(async () => value * 2)))).resolves.toEqual([2, 4, 6]);
  });
});

describe('createSealedTransport', () => {
  it('passes everything through before a handshake', async () => {
    // Loopback never seals, so every call site runs unchanged there.
    const transport = createSealedTransport();
    expect(transport.active()).toBe(false);
    await expect(transport.sealText('plain')).resolves.toBe('plain');
    await expect(transport.openText('plain')).resolves.toBe('plain');
  });

  it('round-trips text to the host half and leaves no plaintext on the wire', async () => {
    const { transport, server } = await pair();
    expect(transport.active()).toBe(true);
    const sealed = await transport.sealText('{"type":"prompt"}');
    expect(sealed).not.toContain('prompt');
    const opened = server.open(JSON.parse(sealed));
    expect(opened.ok && new TextDecoder().decode(opened.plaintext)).toBe('{"type":"prompt"}');
  });

  it('keeps counters in order when a burst is sealed at once', async () => {
    // Fired without awaiting between them, which is how a burst of socket sends
    // actually arrives. Reordered counters here would be dropped as replays.
    const { transport, server } = await pair();
    const messages = Array.from({ length: 50 }, (_value, index) => `message ${String(index)}`);
    const sealed = await Promise.all(messages.map(async (message) => await transport.sealText(message)));
    const opened = sealed.map((envelope) => server.open(JSON.parse(envelope)));
    expect(opened.every((result) => result.ok)).toBe(true);
    expect(opened.map((result) => (result.ok ? new TextDecoder().decode(result.plaintext) : ''))).toEqual(messages);
  });

  it('keeps counters in order when a burst is opened at once', async () => {
    const { transport, server } = await pair();
    const messages = Array.from({ length: 50 }, (_value, index) => `reply ${String(index)}`);
    const envelopes = messages.map((message) => {
      const sealed = server.seal(new TextEncoder().encode(message));
      if (!sealed.ok) throw new Error(sealed.failure);
      return JSON.stringify(sealed.envelope);
    });
    await expect(Promise.all(envelopes.map(async (envelope) => await transport.openText(envelope)))).resolves.toEqual(
      messages,
    );
  });

  it('carries binary untouched, which the Pi socket needs', async () => {
    const { transport, server } = await pair();
    const payload = new Uint8Array([0, 128, 255, 1, 2]);
    const sealed = await transport.sealBinary(payload);
    const opened = server.open(JSON.parse(new TextDecoder().decode(sealed)));
    expect(opened.ok && Array.from(opened.plaintext)).toEqual(Array.from(payload));
  });

  it('names the cause when a message cannot be opened', async () => {
    // A silent failure here is a blank cockpit with nothing to go on.
    const { transport } = await pair();
    await expect(transport.openText('{"v":1,"n":"AAAA","c":"AAAA"}')).resolves.toBeUndefined();
    expect(transport.lastFailure()).toContain('shaped');
  });

  it('never returns plaintext after an active channel fails to seal', async () => {
    vi.resetModules();
    vi.doMock('../../src/adapters/browserSealedChannel.ts', () => ({
      connectSealedChannel: async () => ({
        clientPublicKey: 'client-key',
        channel: {
          seal: async () => ({ ok: false as const, failure: 'exhausted' as const }),
          open: async () => ({ ok: false as const, failure: 'auth' as const }),
        },
      }),
    }));
    try {
      const { createSealedTransport: createFailingTransport } = await import('../../src/adapters/sealedTransport.ts');
      const transport = createFailingTransport();
      await expect(transport.connect('host-key')).resolves.toBe('client-key');
      await expect(transport.sealText('private prompt')).rejects.toThrow('message limit');
      await expect(transport.sealBinary(new Uint8Array([1, 2, 3]))).rejects.toThrow('message limit');
    } finally {
      vi.doUnmock('../../src/adapters/browserSealedChannel.ts');
      vi.resetModules();
    }
  });
  it('hides the complete HTTP request and response inside one relay exchange', async () => {
    const { transport, server } = await pair();
    transport.relayRequestsThrough('/api/remote/request');
    const relay = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input).toBe('/api/remote/request');
      const wire = typeof init?.body === 'string' ? init.body : '';
      expect(wire).not.toContain('private prompt');
      expect(wire).not.toContain('/api/private');
      const opened = server.open(JSON.parse(wire));
      if (!opened.ok) throw new Error(opened.failure);
      expect(JSON.parse(new TextDecoder().decode(opened.plaintext))).toMatchObject({
        v: 1,
        method: 'POST',
        target: '/api/private?view=full',
      });
      const sealed = server.seal(
        new TextEncoder().encode(
          JSON.stringify({
            v: 1,
            status: 201,
            headers: [['content-type', 'application/json']],
            body: btoa('{"result":"private answer"}'),
          }),
        ),
      );
      if (!sealed.ok) throw new Error(sealed.failure);
      return new Response(JSON.stringify(sealed.envelope));
    });
    vi.stubGlobal('fetch', relay);
    try {
      const response = await transport.fetch('/api/private?view=full', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"prompt":"private prompt"}',
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({ result: 'private answer' });
      expect(relay).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('falls back to pass-through once reset', async () => {
    const { transport } = await pair();
    transport.reset();
    expect(transport.active()).toBe(false);
    await expect(transport.sealText('plain')).resolves.toBe('plain');
  });

  it('refuses a host key that is not a key', async () => {
    const transport = createSealedTransport();
    await expect(transport.connect('not-a-key')).resolves.toBeUndefined();
    expect(transport.active()).toBe(false);
    expect(transport.lastFailure()).toContain('could not establish');
  });
});
