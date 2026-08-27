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

describe('ceremonies where passkeys are unavailable', () => {
  it('offers no registration, sign-in, or step-up', async () => {
    const { webauthn } = build(QUICK);
    await expect(webauthn.beginRegistration('iPhone')).resolves.toBeUndefined();
    await expect(webauthn.beginAuthentication()).resolves.toBeUndefined();
    await expect(webauthn.beginStepUp('session.create')).resolves.toBeUndefined();
    await expect(webauthn.finishStepUp('session.create', {})).resolves.toBe(false);
    expect((await webauthn.finishRegistration({}, 'iPhone')).ok).toBe(false);
    expect((await webauthn.finishAuthentication({})).ok).toBe(false);
  });
});

describe('challenges', () => {
  it('mints a registration challenge bound to the tunnel', async () => {
    const { webauthn } = build(NAMED);
    const options = await webauthn.beginRegistration('iPhone');
    expect(options).toBeDefined();
    expect(options?.rp).toMatchObject({ id: 'doom.example.com' });
    // Discoverable and verified, so a return visit is one gesture with nothing
    // typed and the key lands in the device's secure enclave.
    expect(options?.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
  });

  it('refuses a registration whose challenge has expired', async () => {
    const { webauthn, advance } = build(NAMED);
    await webauthn.beginRegistration('iPhone');
    advance(200_000);
    const outcome = await webauthn.finishRegistration({ id: 'x' }, 'iPhone');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('expired');
  });

  it('refuses a step-up answered with a challenge minted for another action', async () => {
    // A challenge is bound to one action so it cannot be replayed to authorise
    // a different one.
    const { webauthn } = build(NAMED);
    await webauthn.beginStepUp('session.create');
    await expect(webauthn.finishStepUp('provider.login', { id: 'x' })).resolves.toBe(false);
  });

  it('consumes a challenge, so the same gesture cannot authorise twice', async () => {
    const { webauthn } = build(NAMED);
    await webauthn.beginStepUp('session.create');
    await webauthn.finishStepUp('session.create', { id: 'unknown' });
    await expect(webauthn.finishStepUp('session.create', { id: 'unknown' })).resolves.toBe(false);
  });

  it('drops every outstanding challenge when the tunnel goes down', async () => {
    const { webauthn } = build(NAMED);
    await webauthn.beginStepUp('session.create');
    webauthn.clearChallenges();
    await expect(webauthn.finishStepUp('session.create', { id: 'x' })).resolves.toBe(false);
  });

  it('refuses an assertion naming a credential that is not registered here', async () => {
    const { webauthn } = build(NAMED);
    await webauthn.beginAuthentication();
    const outcome = await webauthn.finishAuthentication({ id: 'never-seen' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('not registered');
  });

  it('refuses an assertion that names no credential at all', async () => {
    const { webauthn } = build(NAMED);
    await webauthn.beginAuthentication();
    const outcome = await webauthn.finishAuthentication({});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('named no credential');
  });
});
