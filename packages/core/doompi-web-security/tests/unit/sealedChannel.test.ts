import { createECDH } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHostHandshake, type SealedChannel as ServerChannel } from '../../src/adapters/nodeSealedChannel.ts';
import {
  channelFromSecret,
  connectSealedChannel,
  type SealedChannel as ClientChannel,
} from '../../src/adapters/browserSealedChannel.ts';
import { NONCE_BYTES, NONCE_PREFIX_BYTES, SEALED_VERSION } from '../../src/types/sealedChannel.ts';

const text = new TextEncoder();
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

let server: ServerChannel;
let client: ClientChannel;

/**
 * Both halves over one ECDH secret.
 *
 * The client's nonce prefix is zero and the server's is random, which is the
 * real arrangement: each side chooses its own and the other reads it off the
 * wire, so the two directions can never collide in nonce space.
 */
beforeEach(async () => {
  const host = createHostHandshake();
  const peer = createECDH('prime256v1');
  peer.generateKeys();
  const accepted = host.accept(peer.getPublicKey().toString('base64url'));
  if (accepted === undefined) throw new Error('the host refused the handshake');
  server = accepted;

  const secret = peer.computeSecret(Buffer.from(host.publicKey, 'base64url'));
  const copy = new Uint8Array(new ArrayBuffer(secret.length));
  copy.set(secret);
  client = await channelFromSecret(copy.buffer, 'c2s', new Uint8Array(NONCE_PREFIX_BYTES));
});

describe('node seals and WebCrypto opens', () => {
  it('round-trips server to client', async () => {
    const sealed = server.seal(text.encode('from the hub'));
    if (!sealed.ok) throw new Error(sealed.failure);
    const opened = await client.open(sealed.envelope);
    expect(opened.ok && decode(opened.plaintext)).toBe('from the hub');
  });

  it('round-trips client to server', async () => {
    const sealed = await client.seal(text.encode('from the phone'));
    if (!sealed.ok) throw new Error(sealed.failure);
    const opened = server.open(sealed.envelope);
    expect(opened.ok && decode(opened.plaintext)).toBe('from the phone');
  });

  it('carries binary untouched, which is what the Pi socket needs', async () => {
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const sealed = server.seal(payload);
    if (!sealed.ok) throw new Error(sealed.failure);
    const opened = await client.open(sealed.envelope);
    expect(opened.ok && Array.from(opened.plaintext)).toEqual(Array.from(payload));
  });

  it('keeps a long conversation in order', async () => {
    for (let index = 0; index < 200; index += 1) {
      const sealed = server.seal(text.encode(`message ${String(index)}`));
      if (!sealed.ok) throw new Error(sealed.failure);
      const opened = await client.open(sealed.envelope);
      expect(opened.ok && decode(opened.plaintext)).toBe(`message ${String(index)}`);
    }
  });
});

describe('nonce discipline', () => {
  it('never repeats a nonce across ten thousand messages', () => {
    // A repeated nonce under one AES-GCM key leaks the XOR of two plaintexts
    // and the authentication subkey. This is the assertion that matters most.
    const seen = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      const sealed = server.seal(text.encode('x'));
      if (!sealed.ok) throw new Error(sealed.failure);
      seen.add(sealed.envelope.n);
    }
    expect(seen.size).toBe(10_000);
  });

  it('keeps the two directions in separate nonce spaces', async () => {
    const fromServer = server.seal(text.encode('a'));
    const fromClient = await client.seal(text.encode('a'));
    if (!fromServer.ok || !fromClient.ok) throw new Error('seal failed');
    expect(fromServer.envelope.n).not.toBe(fromClient.envelope.n);
  });

  it('emits a nonce of exactly the standard length', () => {
    const sealed = server.seal(text.encode('a'));
    if (!sealed.ok) throw new Error(sealed.failure);
    expect(Buffer.from(sealed.envelope.n, 'base64url')).toHaveLength(NONCE_BYTES);
  });
});

describe('what a relay cannot do', () => {
  it('refuses a replayed message', async () => {
    const sealed = server.seal(text.encode('once'));
    if (!sealed.ok) throw new Error(sealed.failure);
    await client.open(sealed.envelope);
    expect(await client.open(sealed.envelope)).toEqual({ ok: false, failure: 'replay' });
  });

  it('refuses a message whose counter went backwards', async () => {
    const first = server.seal(text.encode('one'));
    const second = server.seal(text.encode('two'));
    if (!first.ok || !second.ok) throw new Error('seal failed');
    await client.open(second.envelope);
    expect(await client.open(first.envelope)).toEqual({ ok: false, failure: 'replay' });
  });

  it('refuses a ciphertext with one bit flipped', async () => {
    const sealed = server.seal(text.encode('intact'));
    if (!sealed.ok) throw new Error(sealed.failure);
    const body = Buffer.from(sealed.envelope.c, 'base64url');
    body[0] ^= 1;
    const opened = await client.open({ ...sealed.envelope, c: body.toString('base64url') });
    expect(opened).toEqual({ ok: false, failure: 'auth' });
  });

  it('refuses a message whose tag was replaced', async () => {
    const sealed = server.seal(text.encode('intact'));
    if (!sealed.ok) throw new Error(sealed.failure);
    const body = Buffer.from(sealed.envelope.c, 'base64url');
    body[body.length - 1] ^= 0xff;
    expect(await client.open({ ...sealed.envelope, c: body.toString('base64url') })).toEqual({
      ok: false,
      failure: 'auth',
    });
  });

  it('cannot replay a server message back at the server', () => {
    // Separate keys per direction is what stops this; one shared key would let
    // a relay bounce a message and have it verify.
    const sealed = server.seal(text.encode('echo'));
    if (!sealed.ok) throw new Error(sealed.failure);
    expect(server.open(sealed.envelope).ok).toBe(false);
  });

  it('refuses an envelope from a different handshake', async () => {
    const stranger = createHostHandshake();
    const peer = createECDH('prime256v1');
    peer.generateKeys();
    const other = stranger.accept(peer.getPublicKey().toString('base64url'));
    if (other === undefined) throw new Error('no channel');
    const sealed = other.seal(text.encode('not yours'));
    if (!sealed.ok) throw new Error(sealed.failure);
    expect((await client.open(sealed.envelope)).ok).toBe(false);
  });
});

describe('malformed input', () => {
  it.each([
    [{ v: SEALED_VERSION + 1, n: 'AAAA', c: 'AAAA' }, 'version'],
    [{ v: SEALED_VERSION, n: 'AAAA', c: 'AAAA' }, 'malformed'],
    [{ v: SEALED_VERSION, n: 'not base64!', c: 'AAAA' }, 'malformed'],
    [{ nope: true }, 'malformed'],
    ['a string', 'malformed'],
    [undefined, 'malformed'],
  ])('reports %j as %s', async (envelope, failure) => {
    expect(await client.open(envelope)).toEqual({ ok: false, failure });
    expect(server.open(envelope)).toEqual({ ok: false, failure });
  });
});

describe('the handshake', () => {
  it('refuses a peer key that is not a point on the curve', () => {
    expect(createHostHandshake().accept('bm90LWEta2V5')).toBeUndefined();
  });

  it('lets the browser side complete against the host key from the QR', async () => {
    const host = createHostHandshake();
    const connected = await connectSealedChannel(host.publicKey);
    if (connected === undefined) throw new Error('the browser refused the handshake');
    const accepted = host.accept(connected.clientPublicKey);
    if (accepted === undefined) throw new Error('the host refused the browser key');
    const sealed = accepted.seal(text.encode('hello phone'));
    if (!sealed.ok) throw new Error(sealed.failure);
    const opened = await connected.channel.open(sealed.envelope);
    expect(opened.ok && decode(opened.plaintext)).toBe('hello phone');
  });

  it('gives a different secret to every tunnel', () => {
    expect(createHostHandshake().publicKey).not.toBe(createHostHandshake().publicKey);
  });
});
