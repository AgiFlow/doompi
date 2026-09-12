import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebAuthn } from '../../../../src/services/webauthn';
import {
  CEREMONY_TTL_MS,
  STEP_UP_CHALLENGE_TTL_MS,
  type StoredCredential,
} from '../../../../src/services/webauthnPolicy';

const mock = vi.hoisted(() => ({
  registrationOptions: vi.fn(),
  authenticationOptions: vi.fn(),
  registrationResponse: vi.fn(),
  authenticationResponse: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mock.registrationOptions,
  generateAuthenticationOptions: mock.authenticationOptions,
  verifyRegistrationResponse: mock.registrationResponse,
  verifyAuthenticationResponse: mock.authenticationResponse,
}));

const stored: StoredCredential = {
  id: 'stored-1',
  credentialId: 'credential-1',
  publicKey: Buffer.from('public key').toString('base64url'),
  counter: 3,
  transports: ['internal'],
  label: 'Phone',
  createdAt: 1,
  lastUsedAt: 1,
};

function fixture() {
  let origin: string | undefined = 'https://access.example.com';
  let time = 1000;
  const credentials: StoredCredential[] = [stored];
  const save = vi.fn((credential: StoredCredential) => {
    const index = credentials.findIndex((candidate) => candidate.id === credential.id);
    if (index >= 0) credentials[index] = credential;
    else credentials.push(credential);
  });
  const remove = vi.fn((id: string) => {
    const index = credentials.findIndex((credential) => credential.id === id);
    if (index < 0) return false;
    credentials.splice(index, 1);
    return true;
  });
  const notice = vi.fn();
  const auth = createWebAuthn({
    publicOrigin: () => origin,
    credentials: () => credentials,
    saveCredential: save,
    removeCredential: remove,
    now: () => time,
    onNotice: notice,
  });
  return {
    auth,
    credentials,
    save,
    remove,
    notice,
    setOrigin: (value: string | undefined) => {
      origin = value;
    },
    setTime: (value: number) => {
      time = value;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.registrationOptions.mockResolvedValue({ challenge: 'registration-challenge' });
  mock.authenticationOptions.mockResolvedValue({ challenge: 'authentication-challenge' });
  mock.registrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: { credential: { id: 'new-credential', publicKey: new Uint8Array([1, 2]), counter: 0 } },
  });
  mock.authenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 4 } });
});

describe('WebAuthn ceremonies', () => {
  it('requires a stable public origin and binds registration to the caller', async () => {
    const { auth, setOrigin, save, notice } = fixture();
    setOrigin(undefined);
    expect(auth.support()).toEqual({ supported: false, reason: 'Remote access is not on.' });
    expect(await auth.beginRegistration('one', 'Phone')).toBeUndefined();
    expect(await auth.finishRegistration('missing', 'one', {}, 'Phone')).toMatchObject({ ok: false });
    setOrigin('https://temporary.trycloudflare.com');
    expect(auth.support()).toMatchObject({ supported: false });
    setOrigin('https://access.example.com');
    expect(auth.support()).toEqual({ supported: true, rpId: 'access.example.com' });
    const begun = await auth.beginRegistration('one', 'Phone');
    expect(begun?.options).toEqual({ challenge: 'registration-challenge' });
    expect(mock.registrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'access.example.com',
        userDisplayName: 'Phone',
        excludeCredentials: [{ id: 'credential-1' }],
      }),
    );
    expect(await auth.finishRegistration(begun!.ceremonyId, 'other', {}, 'Phone')).toMatchObject({ ok: false });
    const result = await auth.finishRegistration(begun!.ceremonyId, 'one', {}, 'Phone');
    expect(result).toMatchObject({ ok: true, id: expect.any(String) });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: 'new-credential',
        publicKey: 'AQI',
        counter: 0,
        transports: [],
        label: 'Phone',
      }),
    );
    expect(notice).toHaveBeenCalledWith('registered a passkey for Phone');
    expect(await auth.finishRegistration(begun!.ceremonyId, 'one', {}, 'Phone')).toMatchObject({ ok: false });
  });

  it('handles rejected and expired registration verification', async () => {
    const { auth, setTime } = fixture();
    const first = await auth.beginRegistration('one', 'Phone');
    mock.registrationResponse.mockResolvedValueOnce({ verified: false });
    expect(await auth.finishRegistration(first!.ceremonyId, 'one', {}, 'Phone')).toEqual({
      ok: false,
      error: 'That passkey could not be verified.',
    });
    const second = await auth.beginRegistration('one', 'Phone');
    mock.registrationResponse.mockRejectedValueOnce(new Error('invalid attestation'));
    expect(await auth.finishRegistration(second!.ceremonyId, 'one', {}, 'Phone')).toEqual({
      ok: false,
      error: 'invalid attestation',
    });
    const third = await auth.beginRegistration('one', 'Phone');
    setTime(1000 + CEREMONY_TTL_MS);
    expect(await auth.finishRegistration(third!.ceremonyId, 'one', {}, 'Phone')).toMatchObject({ ok: false });
  });

  it('authenticates a registered passkey and rejects missing or invalid credentials', async () => {
    const { auth, save } = fixture();
    const begun = await auth.beginAuthentication('one');
    expect(begun?.options).toEqual({ challenge: 'authentication-challenge' });
    expect(await auth.finishAuthentication(begun!.ceremonyId, 'other', { id: stored.credentialId })).toMatchObject({
      ok: false,
    });
    expect(await auth.finishAuthentication(begun!.ceremonyId, 'one', {})).toEqual({
      ok: false,
      error: 'That response named no credential.',
    });
    const unknown = await auth.beginAuthentication('one');
    expect(await auth.finishAuthentication(unknown!.ceremonyId, 'one', { id: 'unknown' })).toEqual({
      ok: false,
      error: 'That passkey is not registered here.',
    });
    const valid = await auth.beginAuthentication('one');
    const result = await auth.finishAuthentication(valid!.ceremonyId, 'one', { id: stored.credentialId });
    expect(result).toMatchObject({ ok: true, credential: { id: stored.id, counter: 4, lastUsedAt: 1000 } });
    expect(save).toHaveBeenCalled();
    expect(mock.authenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: 'https://access.example.com',
        expectedRPID: 'access.example.com',
      }),
    );
  });

  it('rejects failed signatures and revokes a credential when its counter goes backwards', async () => {
    const { auth, remove, notice } = fixture();
    const failed = await auth.beginAuthentication('one');
    mock.authenticationResponse.mockResolvedValueOnce({ verified: false });
    expect(await auth.finishAuthentication(failed!.ceremonyId, 'one', { id: stored.credentialId })).toEqual({
      ok: false,
      error: 'That passkey did not verify.',
    });
    const thrown = await auth.beginAuthentication('one');
    mock.authenticationResponse.mockRejectedValueOnce('bad signature');
    expect(await auth.finishAuthentication(thrown!.ceremonyId, 'one', { id: stored.credentialId })).toEqual({
      ok: false,
      error: 'bad signature',
    });
    const cloned = await auth.beginAuthentication('one');
    mock.authenticationResponse.mockResolvedValueOnce({ verified: true, authenticationInfo: { newCounter: 3 } });
    expect(await auth.finishAuthentication(cloned!.ceremonyId, 'one', { id: stored.credentialId })).toMatchObject({
      ok: false,
      error: 'That passkey looks cloned and has been revoked.',
    });
    expect(remove).toHaveBeenCalledWith(stored.id);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('counter went backwards'));
  });

  it('binds step-up challenges to their action, caller, and expiry', async () => {
    const { auth, setTime, setOrigin } = fixture();
    const begun = await auth.beginStepUp('one', 'session.create');
    expect(await auth.finishStepUp(begun!.ceremonyId, 'one', 'provider.login', { id: stored.credentialId })).toBe(
      false,
    );
    expect(await auth.finishStepUp(begun!.ceremonyId, 'other', 'session.create', { id: stored.credentialId })).toBe(
      false,
    );
    expect(await auth.finishStepUp(begun!.ceremonyId, 'one', 'session.create', { id: stored.credentialId })).toBe(true);
    expect(await auth.finishStepUp(begun!.ceremonyId, 'one', 'session.create', { id: stored.credentialId })).toBe(
      false,
    );
    const expired = await auth.beginStepUp('one', 'session.create');
    setTime(1000 + STEP_UP_CHALLENGE_TTL_MS);
    expect(await auth.finishStepUp(expired!.ceremonyId, 'one', 'session.create', { id: stored.credentialId })).toBe(
      false,
    );
    const cleared = await auth.beginStepUp('one', 'session.create');
    auth.clearChallenges();
    expect(await auth.finishStepUp(cleared!.ceremonyId, 'one', 'session.create', { id: stored.credentialId })).toBe(
      false,
    );
    setOrigin(undefined);
    expect(await auth.beginAuthentication('one')).toBeUndefined();
    expect(await auth.beginStepUp('one', 'session.create')).toBeUndefined();
    expect(await auth.finishAuthentication('missing', 'one', {})).toMatchObject({ ok: false });
    expect(await auth.finishStepUp('missing', 'one', 'session.create', {})).toBe(false);
  });
});
