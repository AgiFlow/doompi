import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  CEREMONY_TTL_MS,
  STEP_UP_CHALLENGE_TTL_MS,
  type StepUpAction,
  type StoredCredential,
  challengeIsFresh,
  counterVerdict,
  relyingPartyId,
} from '../services/webauthnPolicy.ts';

const ID_BYTES = 8;
const CEREMONY_ID_BYTES = 16;
const USER_ID_BYTES = 16;
const MAX_PENDING_CEREMONIES = 256;
const RP_NAME = 'DoomPi cockpit';
/** One synthetic owner: there is exactly one person here, and passkeys need a subject. */
const OWNER_NAME = 'this machine';
export interface WebAuthnOptions {
  /** The tunnel origin, or undefined while remote access is off. */
  publicOrigin: () => string | undefined;
  credentials: () => readonly StoredCredential[];
  saveCredential: (credential: StoredCredential) => void;
  removeCredential: (id: string) => boolean;
  now?: () => number;
  onNotice?: (message: string) => void;
}

export type PasskeySupport = { supported: true; rpId: string } | { supported: false; reason: string };

export interface BegunCeremony {
  ceremonyId: string;
  options: Record<string, unknown>;
}

export interface WebAuthn {
  /** Whether the current tunnel can carry passkeys at all. */
  support(): PasskeySupport;
  beginRegistration(caller: string, label: string): Promise<BegunCeremony | undefined>;
  finishRegistration(
    ceremonyId: string,
    caller: string,
    response: unknown,
    label: string,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  beginAuthentication(caller: string): Promise<BegunCeremony | undefined>;
  finishAuthentication(
    ceremonyId: string,
    caller: string,
    response: unknown,
  ): Promise<{ ok: true; credential: StoredCredential } | { ok: false; error: string }>;
  /** Mints a challenge bound to one caller and action, good once and briefly. */
  beginStepUp(caller: string, action: StepUpAction): Promise<BegunCeremony | undefined>;
  finishStepUp(ceremonyId: string, caller: string, action: StepUpAction, response: unknown): Promise<boolean>;
  clearChallenges(): void;
}

type CeremonyType = 'registration' | 'authentication' | 'step-up';

interface PendingChallenge {
  challenge: string;
  issuedAt: number;
  caller: string;
  type: CeremonyType;
  /** Present for a step-up, so a challenge minted for one action cannot authorise another. */
  action?: StepUpAction;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Passkeys over the tunnel, and the step-up gate in front of the two actions a
 * live session should not be enough for.
 *
 * `rpID` and `expectedOrigin` come from the configured tunnel hostname, never
 * from the request. That is the entire scope of a credential, so a caller that
 * could influence it could mint credentials against somebody else's origin.
 */
export function createWebAuthn(options: WebAuthnOptions): WebAuthn {
  const now = options.now ?? ((): number => Date.now());
  const notice = options.onNotice ?? ((): void => {});
  /** One synthetic subject, stable for the life of the process. */
  const userId = randomBytes(USER_ID_BYTES);
  const pending = new Map<string, PendingChallenge>();

  const support = (): PasskeySupport => {
    const origin = options.publicOrigin();
    const rpId = relyingPartyId(origin);
    if (origin === undefined) return { supported: false, reason: 'Remote access is not on.' };
    if (rpId === undefined) {
      return {
        supported: false,
        reason:
          'A quick tunnel gets a new hostname every start, so a passkey registered now would not work again. Configure a named tunnel to use passkeys.',
      };
    }
    return { supported: true, rpId };
  };

  const ceremonyKey = (id: string, caller: string, type: CeremonyType): string => `${type}\u0000${caller}\u0000${id}`;
  const ttlFor = (held: PendingChallenge): number =>
    held.type === 'step-up' ? STEP_UP_CHALLENGE_TTL_MS : CEREMONY_TTL_MS;

  const sweepPending = (): void => {
    const at = now();
    for (const [id, held] of pending) {
      if (!challengeIsFresh(held.issuedAt, at, ttlFor(held))) pending.delete(id);
    }
  };

  const remember = (type: CeremonyType, caller: string, challenge: string, action?: StepUpAction): string => {
    sweepPending();
    while (pending.size >= MAX_PENDING_CEREMONIES) {
      const oldest = pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    let id: string;
    do {
      id = randomBytes(CEREMONY_ID_BYTES).toString('base64url');
    } while (pending.has(ceremonyKey(id, caller, type)));
    pending.set(ceremonyKey(id, caller, type), {
      challenge,
      issuedAt: now(),
      caller,
      type,
      ...(action === undefined ? {} : { action }),
    });
    return id;
  };

  const take = (id: string, caller: string, type: CeremonyType, action?: StepUpAction): string | undefined => {
    const key = ceremonyKey(id, caller, type);
    const held = pending.get(key);
    if (held === undefined) return undefined;
    if (!challengeIsFresh(held.issuedAt, now(), ttlFor(held))) {
      pending.delete(key);
      return undefined;
    }
    if (held.caller !== caller || held.type !== type || held.action !== action) return undefined;
    pending.delete(key);
    return held.challenge;
  };

  return {
    support,

    async beginRegistration(caller, label) {
      const ready = support();
      if (!ready.supported) return undefined;
      const options_ = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: ready.rpId,
        userID: userId,
        userName: OWNER_NAME,
        userDisplayName: label,
        attestationType: 'none',
        // Discoverable so a return visit is one gesture with nothing typed,
        // and platform so the key lands in the phone's secure enclave rather
        // than on a roaming key the user has to carry.
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
          authenticatorAttachment: 'platform',
        },
        excludeCredentials: options.credentials().map((credential) => ({ id: credential.credentialId })),
      });
      const ceremonyId = remember('registration', caller, options_.challenge);
      return { ceremonyId, options: options_ as unknown as Record<string, unknown> };
    },

    async finishRegistration(ceremonyId, caller, response, label) {
      const ready = support();
      if (!ready.supported) return { ok: false, error: ready.reason };
      const challenge = take(ceremonyId, caller, 'registration');
      if (challenge === undefined) return { ok: false, error: 'That registration expired. Try again.' };
      try {
        const verification = await verifyRegistrationResponse({
          response: response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
          expectedChallenge: challenge,
          expectedOrigin: `https://${ready.rpId}`,
          expectedRPID: ready.rpId,
          requireUserVerification: true,
        });
        if (!verification.verified || verification.registrationInfo === undefined) {
          return { ok: false, error: 'That passkey could not be verified.' };
        }
        const info = verification.registrationInfo;
        const at = now();
        const credential: StoredCredential = {
          id: randomBytes(ID_BYTES).toString('hex'),
          credentialId: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
          counter: info.credential.counter,
          transports: info.credential.transports ?? [],
          label,
          createdAt: at,
          lastUsedAt: at,
        };
        options.saveCredential(credential);
        notice(`registered a passkey for ${label}`);
        return { ok: true, id: credential.id };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },

    async beginAuthentication(caller) {
      const ready = support();
      if (!ready.supported) return undefined;
      const options_ = await generateAuthenticationOptions({
        rpID: ready.rpId,
        userVerification: 'required',
      });
      const ceremonyId = remember('authentication', caller, options_.challenge);
      return { ceremonyId, options: options_ as unknown as Record<string, unknown> };
    },

    async finishAuthentication(ceremonyId, caller, response) {
      const ready = support();
      if (!ready.supported) return { ok: false, error: ready.reason };
      const challenge = take(ceremonyId, caller, 'authentication');
      if (challenge === undefined) return { ok: false, error: 'That sign-in expired. Try again.' };
      return await verifyAgainst(challenge, ready.rpId, response);
    },

    async beginStepUp(caller, action) {
      const ready = support();
      if (!ready.supported) return undefined;
      const options_ = await generateAuthenticationOptions({
        rpID: ready.rpId,
        userVerification: 'required',
      });
      const ceremonyId = remember('step-up', caller, options_.challenge, action);
      return { ceremonyId, options: options_ as unknown as Record<string, unknown> };
    },

    async finishStepUp(ceremonyId, caller, action, response) {
      const ready = support();
      if (!ready.supported) return false;
      const challenge = take(ceremonyId, caller, 'step-up', action);
      if (challenge === undefined) return false;
      return (await verifyAgainst(challenge, ready.rpId, response)).ok;
    },

    clearChallenges() {
      pending.clear();
    },
  };

  async function verifyAgainst(
    challenge: string,
    rpId: string,
    response: unknown,
  ): Promise<{ ok: true; credential: StoredCredential } | { ok: false; error: string }> {
    const presented = (response as { id?: unknown }).id;
    if (typeof presented !== 'string') return { ok: false, error: 'That response named no credential.' };
    const stored = options.credentials().find((candidate) => candidate.credentialId === presented);
    if (stored === undefined) return { ok: false, error: 'That passkey is not registered here.' };
    try {
      const verification = await verifyAuthenticationResponse({
        response: response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
        expectedChallenge: challenge,
        expectedOrigin: `https://${rpId}`,
        expectedRPID: rpId,
        requireUserVerification: true,
        credential: {
          id: stored.credentialId,
          publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
          counter: stored.counter,
          transports: stored.transports as never,
        },
      });
      if (!verification.verified) return { ok: false, error: 'That passkey did not verify.' };
      const presentedCounter = verification.authenticationInfo.newCounter;
      if (counterVerdict(stored.counter, presentedCounter) === 'clone-suspected') {
        // Two things are signing with one key. The credential is burnt.
        options.removeCredential(stored.id);
        notice(`revoked passkey ${stored.label}: its signature counter went backwards, which means a clone`);
        return { ok: false, error: 'That passkey looks cloned and has been revoked.' };
      }
      const updated: StoredCredential = { ...stored, counter: presentedCounter, lastUsedAt: now() };
      options.saveCredential(updated);
      return { ok: true, credential: updated };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }
}
