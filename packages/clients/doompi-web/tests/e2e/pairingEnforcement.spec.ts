import { connectSealedChannel } from '@agimon-ai/doompi-web-security/browser';
import { expect, test } from '../support/remoteListener.ts';

test.setTimeout(120_000);

const HOSTILE_ORIGIN = 'https://evil.example';
const SEALED_HTTP_VERSION = 1;

function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0] ?? '';
}

test('enforces pairing before granting authenticated tunnel access', async ({ request, remoteListener }) => {
  await remoteListener.enable();

  const unpaired = await request.get(remoteListener.tunnelUrl('/api/health'), {
    headers: { origin: remoteListener.tunnelOrigin() },
  });
  expect(unpaired.status()).toBe(401);
  await unpaired.dispose();

  const badOrigin = await request.get(remoteListener.tunnelUrl('/api/health'), {
    headers: { origin: HOSTILE_ORIGIN },
  });
  expect(badOrigin.status()).toBe(403);
  await badOrigin.dispose();

  const minted = await request.post(remoteListener.localUrl('/api/remote/codes'));
  expect(minted.status()).toBe(201);
  const { code } = (await minted.json()) as { code: string };
  await minted.dispose();

  const badClaim = await request.post(remoteListener.tunnelUrl('/api/remote/pair'), {
    headers: { 'content-type': 'application/json', origin: HOSTILE_ORIGIN },
    data: { code },
  });
  expect(badClaim.status()).toBe(403);
  await badClaim.dispose();

  const claimed = await request.post(remoteListener.tunnelUrl('/api/remote/pair'), {
    headers: { 'content-type': 'application/json', origin: remoteListener.tunnelOrigin() },
    data: { code },
  });
  expect(claimed.status()).toBe(202);
  const { requestId } = (await claimed.json()) as { requestId: string };
  await claimed.dispose();

  const pending = await request.get(remoteListener.tunnelUrl(`/api/remote/pair/status?request=${requestId}`), {
    headers: { origin: remoteListener.tunnelOrigin() },
  });
  expect(pending.status()).toBe(200);
  expect(await pending.json()).toEqual({ status: 'pending' });
  expect(pending.headers()['set-cookie']).toBeUndefined();
  await pending.dispose();

  const approved = await request.post(remoteListener.localUrl(`/api/remote/pairing/${requestId}/approve`));
  expect(approved.status()).toBe(200);
  await approved.dispose();

  const status = await request.get(remoteListener.tunnelUrl(`/api/remote/pair/status?request=${requestId}`), {
    headers: { origin: remoteListener.tunnelOrigin() },
  });
  expect(status.status()).toBe(200);
  const statusBody = (await status.json()) as { status: string; hostPublicKey: string };
  expect(statusBody).toMatchObject({ status: 'approved', hostPublicKey: expect.any(String) });
  const setCookie = status.headers()['set-cookie'];
  expect(setCookie).toBeTruthy();
  if (setCookie === undefined) throw new Error('Pairing approval did not set a device cookie.');
  expect(setCookie).toContain('__Host-doompi_device=');
  expect(setCookie).toContain('; Secure');
  expect(setCookie).toContain('; HttpOnly');
  expect(setCookie).toContain('; SameSite=Lax');
  expect(setCookie).toContain('; Path=/');
  expect(setCookie).not.toContain('; Domain=');
  const deviceCookie = cookieValue(setCookie);
  await status.dispose();

  const directHealth = await request.get(remoteListener.tunnelUrl('/api/health'), {
    headers: { origin: remoteListener.tunnelOrigin(), cookie: deviceCookie },
  });
  expect(directHealth.status()).toBe(401);
  await directHealth.dispose();

  const connected = await connectSealedChannel(statusBody.hostPublicKey);
  if (connected === undefined) throw new Error('The test client could not establish a sealed channel.');
  const openedChannel = await request.post(remoteListener.tunnelUrl('/api/remote/channel'), {
    headers: {
      'content-type': 'application/json',
      origin: remoteListener.tunnelOrigin(),
      cookie: deviceCookie,
    },
    data: { scope: 'http', clientPublicKey: connected.clientPublicKey },
  });
  expect(openedChannel.status()).toBe(200);
  await openedChannel.dispose();

  const sealed = await connected.channel.seal(
    new TextEncoder().encode(
      JSON.stringify({
        v: SEALED_HTTP_VERSION,
        method: 'GET',
        target: '/api/health',
        headers: [],
      }),
    ),
  );
  if (!sealed.ok) throw new Error(`The test request could not be sealed: ${sealed.failure}.`);

  const tunnelResponse = await request.post(remoteListener.tunnelUrl('/api/remote/request'), {
    headers: {
      'content-type': 'application/json',
      origin: remoteListener.tunnelOrigin(),
      cookie: deviceCookie,
    },
    data: sealed.envelope,
  });
  expect(tunnelResponse.status()).toBe(200);
  const opened = await connected.channel.open(await tunnelResponse.json());
  await tunnelResponse.dispose();
  if (!opened.ok) throw new Error(`The test response could not be opened: ${opened.failure}.`);

  const response = JSON.parse(new TextDecoder().decode(opened.plaintext)) as {
    status: number;
    body: string;
  };
  expect(response.status).toBe(200);
  expect(JSON.parse(Buffer.from(response.body, 'base64').toString('utf8'))).toMatchObject({ ok: true, role: 'hub' });
});
