import { describe, expect, it } from 'vitest';
import { createWebAuthn } from '../../src/adapters/webauthn.ts';
import type { StoredCredential } from '../../src/services/webauthnPolicy.ts';

const NAMED = 'https://doom.example.com';
const QUICK = 'https://calm-river-1234.trycloudflare.com';

function build(origin: string | undefined, seed: StoredCredential[] = []) {
  let now = 1_700_000_000_000;
  const saved: StoredCredential[] = [...seed];
  const notices: string[] = [];
  const webauthn = createWebAuthn({
    publicOrigin: () => origin,
    credentials: () => saved,
    saveCredential: (credential) => {
      const at = saved.findIndex((held) => held.id === credential.id);
      if (at >= 0) saved[at] = credential;
      else saved.push(credential);
    },
    removeCredential: (id) => {
      const next = saved.filter((held) => held.id !== id);
      const removed = next.length !== saved.length;
      saved.length = 0;
      saved.push(...next);
      return removed;
    },
    now: () => now,
    onNotice: (message) => notices.push(message),
  });
  return { webauthn, saved, notices, advance: (ms: number) => (now += ms) };
}

describe('passkey support', () => {
  it('is available on a named tunnel', () => {
    expect(build(NAMED).webauthn.support()).toEqual({ supported: true, rpId: 'doom.example.com' });
  });

  it('explains itself on a quick tunnel rather than failing later in the browser', () => {
    const support = build(QUICK).webauthn.support();
    expect(support.supported).toBe(false);
    if (support.supported) return;
    expect(support.reason).toContain('named tunnel');
  });

  it('says remote access is off when there is no tunnel', () => {
    const support = build(undefined).webauthn.support();
    expect(support.supported).toBe(false);
    if (support.supported) return;
    expect(support.reason).toContain('not on');
  });
});

const CALLER_A = 'public:browser-a';
const CALLER_B = 'public:browser-b';

describe('ceremonies where passkeys are unavailable', () => {
  it('offers no registration, sign-in, or step-up', async () => {
    const { webauthn } = build(QUICK);
    await expect(webauthn.beginRegistration('local', 'iPhone')).resolves.toBeUndefined();
    await expect(webauthn.beginAuthentication(CALLER_A)).resolves.toBeUndefined();
    await expect(webauthn.beginStepUp(CALLER_A, 'session.create')).resolves.toBeUndefined();
    await expect(webauthn.finishStepUp('missing', CALLER_A, 'session.create', {})).resolves.toBe(false);
    expect((await webauthn.finishRegistration('missing', 'local', {}, 'iPhone')).ok).toBe(false);
    expect((await webauthn.finishAuthentication('missing', CALLER_A, {})).ok).toBe(false);
  });
});

describe('challenges', () => {
  it('mints a registration challenge bound to the tunnel', async () => {
    const { webauthn } = build(NAMED);
    const begun = await webauthn.beginRegistration('local', 'iPhone');
    expect(begun).toBeDefined();
    expect(begun?.ceremonyId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(begun?.options.rp).toMatchObject({ id: 'doom.example.com' });
    // Discoverable and verified, so a return visit is one gesture with nothing
    // typed and the key lands in the device's secure enclave.
    expect(begun?.options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
  });

  it('refuses a registration whose challenge has expired', async () => {
    const { webauthn, advance } = build(NAMED);
    const begun = await webauthn.beginRegistration('local', 'iPhone');
    expect(begun).toBeDefined();
    advance(200_000);
    const outcome = await webauthn.finishRegistration(begun?.ceremonyId ?? '', 'local', { id: 'x' }, 'iPhone');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('expired');
  });

  it('keeps concurrent sign-ins independent', async () => {
    const { webauthn } = build(NAMED);
    const first = await webauthn.beginAuthentication(CALLER_A);
    await webauthn.beginAuthentication(CALLER_B);
    expect(first).toBeDefined();
    const outcome = await webauthn.finishAuthentication(first?.ceremonyId ?? '', CALLER_A, { id: 'never-seen' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('not registered');
  });

  it('binds a ceremony to the browser that began it without consuming it on mismatch', async () => {
    const { webauthn } = build(NAMED);
    const begun = await webauthn.beginAuthentication(CALLER_A);
    expect(begun).toBeDefined();
    const stolen = await webauthn.finishAuthentication(begun?.ceremonyId ?? '', CALLER_B, { id: 'never-seen' });
    expect(stolen.ok).toBe(false);
    if (stolen.ok) return;
    expect(stolen.error).toContain('expired');

    const rightful = await webauthn.finishAuthentication(begun?.ceremonyId ?? '', CALLER_A, { id: 'never-seen' });
    expect(rightful.ok).toBe(false);
    if (rightful.ok) return;
    expect(rightful.error).toContain('not registered');
  });

  it('binds a challenge to its ceremony type without consuming it on mismatch', async () => {
    const { webauthn } = build(NAMED);
    const begun = await webauthn.beginRegistration('local', 'iPhone');
    expect(begun).toBeDefined();
    const wrongType = await webauthn.finishAuthentication(begun?.ceremonyId ?? '', 'local', { id: 'never-seen' });
    expect(wrongType.ok).toBe(false);
    if (wrongType.ok) return;
    expect(wrongType.error).toContain('expired');

    const rightful = await webauthn.finishRegistration(begun?.ceremonyId ?? '', 'local', { id: 'x' }, 'iPhone');
    expect(rightful.ok).toBe(false);
    if (rightful.ok) return;
    expect(rightful.error).not.toContain('expired');
  });

  it('bounds pending ceremonies and evicts the oldest', async () => {
    const { webauthn } = build(NAMED);
    const begun = [];
    for (let index = 0; index < 257; index += 1) begun.push(await webauthn.beginAuthentication(CALLER_A));
    const oldest = await webauthn.finishAuthentication(begun[0]?.ceremonyId ?? '', CALLER_A, { id: 'never-seen' });
    const newest = await webauthn.finishAuthentication(begun[256]?.ceremonyId ?? '', CALLER_A, { id: 'never-seen' });
    expect(oldest.ok).toBe(false);
    expect(newest.ok).toBe(false);
    if (oldest.ok || newest.ok) return;
    expect(oldest.error).toContain('expired');
    expect(newest.error).toContain('not registered');
  });

  it('refuses a step-up answered with a challenge minted for another action', async () => {
    const { webauthn } = build(NAMED);
    const begun = await webauthn.beginStepUp(CALLER_A, 'session.create');
    expect(begun).toBeDefined();
    await expect(webauthn.finishStepUp(begun?.ceremonyId ?? '', CALLER_A, 'provider.login', { id: 'x' })).resolves.toBe(
      false,
    );
  });

  it('consumes a challenge, so the same gesture cannot authorise twice', async () => {
    const { webauthn } = build(NAMED);
    const begun = await webauthn.beginAuthentication(CALLER_A);
    expect(begun).toBeDefined();
    const first = await webauthn.finishAuthentication(begun?.ceremonyId ?? '', CALLER_A, { id: 'unknown' });
    const replay = await webauthn.finishAuthentication(begun?.ceremonyId ?? '', CALLER_A, { id: 'unknown' });
    expect(first.ok).toBe(false);
    expect(replay.ok).toBe(false);
    if (first.ok || replay.ok) return;
    expect(first.error).toContain('not registered');
    expect(replay.error).toContain('expired');
  });

  it('drops every outstanding challenge when the tunnel goes down', async () => {
    const { webauthn } = build(NAMED);
    const begun = await webauthn.beginStepUp(CALLER_A, 'session.create');
    expect(begun).toBeDefined();
    webauthn.clearChallenges();
    await expect(webauthn.finishStepUp(begun?.ceremonyId ?? '', CALLER_A, 'session.create', { id: 'x' })).resolves.toBe(
      false,
    );
  });

  it('refuses an assertion naming a credential that is not registered here', async () => {
    const { webauthn } = build(NAMED);
    const begun = await webauthn.beginAuthentication(CALLER_A);
    expect(begun).toBeDefined();
    const outcome = await webauthn.finishAuthentication(begun?.ceremonyId ?? '', CALLER_A, { id: 'never-seen' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('not registered');
  });

  it('refuses an assertion that names no credential at all', async () => {
    const { webauthn } = build(NAMED);
    const begun = await webauthn.beginAuthentication(CALLER_A);
    expect(begun).toBeDefined();
    const outcome = await webauthn.finishAuthentication(begun?.ceremonyId ?? '', CALLER_A, {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('named no credential');
  });
});
