import { createHash, randomBytes } from 'node:crypto';
import { type OriginPolicy, tunnelOriginPolicy } from '../services/remoteGuardPolicy.ts';
import { createPairingFlow, type PairingFlow } from '../services/pairingFlow.ts';
import { parseRemoteAccessSettings, serializeRemoteAccessSettings } from '../services/remoteAccessSettings.ts';
import { cookieMaxAgeSeconds } from '../services/deviceSessions.ts';
import {
  PAIRING_PAGE_ROUTE,
  REMOTE_PAIRING_REQUEST_TYPE,
  REMOTE_STATE_TYPE,
  type PairingStatus,
  type RemoteChannelScope,
  type RemoteAccessSettings,
  type RemoteAccessStateView,
  type RemoteAccessStatus,
  type TunnelLauncher,
  type TunnelStartResult,
} from '../types/remoteAccess.ts';
import { COOKIE_CEILING_SECONDS } from '../types/remoteAccess.ts';
import type { StepUpAction, StoredCredential } from '../services/webauthnPolicy.ts';
import { createDeviceAuth, type DeviceAuth, type EnrolledDevice } from './deviceAuth.ts';
import { SEALED_KEY_PARAM } from '@agimon-ai/doompi-web-security';
import { createHostHandshake, type HostHandshake, type SealedChannel } from '@agimon-ai/doompi-web-security/node';
import { createWebAuthn, type PasskeySupport, type WebAuthn } from './webauthn.ts';
import type { RemoteAccessStore } from './remoteAccessStore.ts';

const TOKEN_BYTES = 32;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const MS_PER_MINUTE = 60_000;

/** The tunnel listener, bound by the host so this file never imports an HTTP server. */
export interface TunnelListener {
  port: number;
  close: () => Promise<void>;
}

export interface RemoteAccessOptions {
  store: RemoteAccessStore;
  launchTunnel: TunnelLauncher;
  /** Binds a fresh loopback listener for the tunnel to point at. */
  bindListener: () => Promise<TunnelListener>;
  onNotice?: (message: string) => void;
  /** Frames only the local cockpit may see, such as an approval prompt. */
  broadcastLocal?: (frame: object) => void;
  /** Frames both local and remote pages see. */
  broadcastAll?: (frame: object) => void;
  /**
   * Asks the launcher to hand this cockpit over to a container.
   *
   * A signal rather than a call that does the work, because handing over means
   * closing the server this code is running inside, which it cannot do to
   * itself. The launcher owns that sequence and the rollback if it fails.
   */
  requestHandover?: (settings: RemoteAccessSettings) => void;
  /**
   * Whether this cockpit is already the one inside the container.
   *
   * Without it the contained hub would read the same settings it was handed and
   * try to hand over again, to a container inside a container.
   */
  contained?: boolean;
  now?: () => number;
}

export interface RemoteAccess {
  state(selfDeviceId?: string, forLocalCaller?: boolean): RemoteAccessStateView;
  settings(): RemoteAccessSettings;
  updateSettings(patch: Partial<RemoteAccessSettings>): RemoteAccessSettings;
  tunnelPort(): number | undefined;
  tunnelPolicy(): OriginPolicy | undefined;
  enable(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** True between a contained `enable` and the handover its response defers. */
  handoverPending(): boolean;
  /** Runs that deferred handover, once the response asking for it is on the wire. */
  commitHandover(): void;
  disable(): Promise<void>;
  /** Mints the code a QR carries, and the URL that encodes it. Undefined while the tunnel is down. */
  mintPairing(): { code: string; pairUrl: string; expiresAt: string } | undefined;
  claim(input: {
    code: string;
    userAgent: string | undefined;
    edgeIp: string | undefined;
    sourceAddress: string | undefined;
  }): ReturnType<PairingFlow['claim']>;
  pairingStatus(requestId: string): PairingStatus | undefined;
  approve(requestId: string): ReturnType<PairingFlow['approve']>;
  deny(requestId: string): ReturnType<PairingFlow['deny']>;
  /** Turns an approved request into a session, exactly once. */
  redeem(requestId: string): (EnrolledDevice & { maxAgeSeconds: number }) | undefined;
  authorize(token: string | undefined): string | undefined;
  /** Mints a session for a device that proved a registered passkey. */
  sessionForPasskey(label: string): EnrolledDevice & { maxAgeSeconds: number };
  passkeys(): {
    support: () => PasskeySupport;
    list: () => readonly StoredCredential[];
    beginRegistration: WebAuthn['beginRegistration'];
    finishRegistration: WebAuthn['finishRegistration'];
    beginAuthentication: WebAuthn['beginAuthentication'];
    finishAuthentication: WebAuthn['finishAuthentication'];
    beginStepUp: WebAuthn['beginStepUp'];
    finishStepUp: WebAuthn['finishStepUp'];
    forget: (id: string) => boolean;
  };
  /** Whether this action needs a fresh gesture that has not been supplied. */
  stepUpRequired(action: StepUpAction): boolean;
  /** The host's ephemeral public key for this tunnel, delivered after QR pairing or passkey sign-in. */
  channelPublicKey(): string | undefined;
  /** Completes one purpose-bound sealed channel against a fresh device key. */
  openChannel(deviceId: string, scope: RemoteChannelScope, clientPublicKey: string): boolean;
  channelFor(deviceId: string, scope: RemoteChannelScope): SealedChannel | undefined;
  revokeDevice(id: string): boolean;
  /** Registers a remote socket against its device so revocation closes it immediately. */
  trackSocket(deviceId: string, close: (code: number, reason: string) => void): () => void;
  close(): Promise<void>;
}

export function createRemoteAccess(options: RemoteAccessOptions): RemoteAccess {
  const notice = options.onNotice ?? ((): void => {});
  const now = options.now ?? ((): number => Date.now());
  const broadcastLocal = options.broadcastLocal ?? ((): void => {});
  const broadcastAll = options.broadcastAll ?? ((): void => {});

  let settings = options.store.settings();
  let status: RemoteAccessStatus = 'off';
  let listener: TunnelListener | undefined;
  let stopTunnel: (() => Promise<void>) | undefined;
  let tunnelStartup: { controller: AbortController; outcome: Promise<TunnelStartResult> } | undefined;
  let publicOrigin: string | undefined;
  let policy: OriginPolicy | undefined;
  let startedAt: number | undefined;
  let closesAt: number | undefined;
  let failure: string | undefined;
  /** Settings an `enable` asked to hand over with, waiting for its response to flush. */
  let pendingHandover: RemoteAccessSettings | undefined;
  let autoCloseTimer: ReturnType<typeof setTimeout> | undefined;
  /** One handshake per tunnel; its public half goes in every QR while the tunnel lives. */
  let handshake: HostHandshake | undefined;
  const channels = new Map<string, SealedChannel>();
  const sockets = new Map<string, Set<(code: number, reason: string) => void>>();

  const channelKey = (deviceId: string, scope: RemoteChannelScope): string => `${deviceId}:${scope}`;
  const dropDeviceAccess = (deviceId: string, reason: 'revoked' | 'expired'): void => {
    for (const scope of ['session', 'protocol', 'http'] as const) channels.delete(channelKey(deviceId, scope));
    const held = sockets.get(deviceId);
    sockets.delete(deviceId);
    for (const close of held ?? []) {
      try {
        close(1008, `device ${reason}`);
      } catch {
        // The socket is already gone.
      }
    }
  };

  const devices: DeviceAuth = createDeviceAuth({
    settings: () => settings,
    now,
    onNotice: notice,
    onDrop: (record, reason) => dropDeviceAccess(record.id, reason),
  });

  const webauthn: WebAuthn = createWebAuthn({
    publicOrigin: () => publicOrigin,
    credentials: () => options.store.credentials(),
    saveCredential: (credential) => options.store.saveCredential(credential),
    removeCredential: (id) => options.store.removeCredential(id),
    now,
    onNotice: notice,
  });

  const pairing: PairingFlow = createPairingFlow({
    randomToken: () => randomBytes(TOKEN_BYTES).toString('base64url'),
    digest: (token) => createHash('sha256').update(token).digest('hex'),
    now,
    onNotice: notice,
  });

  const sweeper = setInterval(() => {
    devices.sweep();
    pairing.sweep();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  function publish(): void {
    broadcastAll({ type: REMOTE_STATE_TYPE, state: view(undefined, false) });
  }

  function view(selfDeviceId: string | undefined, forLocalCaller: boolean): RemoteAccessStateView {
    return {
      status,
      ...(publicOrigin === undefined ? {} : { publicUrl: publicOrigin }),
      ...(startedAt === undefined ? {} : { startedAt: new Date(startedAt).toISOString() }),
      ...(closesAt === undefined ? {} : { closesAt: new Date(closesAt).toISOString() }),
      ...(failure === undefined ? {} : { error: failure }),
      devices: devices.list().map((record) => ({
        id: record.id,
        label: record.label,
        userAgent: record.userAgent,
        createdAt: new Date(record.createdAt).toISOString(),
        lastSeenAt: new Date(record.lastSeenAt).toISOString(),
        self: record.id === selfDeviceId,
      })),
      // A paired phone must never see the approval queue: a device that can
      // approve devices makes its own access permanent, which is exactly what
      // host confirmation exists to prevent.
      pending: forLocalCaller
        ? pairing.pending().map((request) => ({
            id: request.id,
            userAgent: request.userAgent,
            edgeIp: request.edgeIp,
            createdAt: new Date(request.createdAt).toISOString(),
            expiresAt: new Date(request.createdAt + 180_000).toISOString(),
          }))
        : [],
      settings,
    };
  }

  function armAutoClose(): void {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = undefined;
    closesAt = undefined;
    if (!settings.autoCloseEnabled || status !== 'on') return;
    const at = now() + settings.autoCloseMinutes * MS_PER_MINUTE;
    closesAt = at;
    autoCloseTimer = setTimeout(() => {
      notice('remote access reached its time limit; closing');
      void disable();
    }, settings.autoCloseMinutes * MS_PER_MINUTE);
    autoCloseTimer.unref();
  }

  /** Everything teardown has to do, in the order it has to happen. */
  async function teardown(): Promise<void> {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = undefined;
    closesAt = undefined;
    // Sockets first. An upgraded socket has left the HTTP server's connection
    // tracking, so closing the listener does not touch it: without this a
    // paired phone keeps driving the agent after remote access is switched off.
    for (const held of sockets.values()) {
      for (const close of held) {
        try {
          close(1008, 'remote access revoked');
        } catch {
          // The socket is already gone, which is the outcome we wanted.
        }
      }
    }
    sockets.clear();
    const starting = tunnelStartup;
    tunnelStartup = undefined;
    starting?.controller.abort();
    const startingOutcome = await starting?.outcome.catch(() => undefined);
    if (startingOutcome?.ok === true) await startingOutcome.stop().catch(() => undefined);
    await stopTunnel?.().catch(() => undefined);
    stopTunnel = undefined;
    await listener?.close().catch(() => undefined);
    listener = undefined;
    publicOrigin = undefined;
    policy = undefined;
    startedAt = undefined;
    pairing.clear();
    webauthn.clearChallenges();
    handshake = undefined;
    channels.clear();
    // Sessions go; passkeys and any other durable credential do not, so
    // switching back on does not mean enrolling every device again.
    devices.revokeAll();
  }

  async function disable(): Promise<void> {
    if (status === 'off') return;
    await teardown();
    status = 'off';
    failure = undefined;
    notice('remote access off');
    publish();
  }

  return {
    state: (selfDeviceId, forLocalCaller = false) => view(selfDeviceId, forLocalCaller),
    settings: () => settings,

    updateSettings(patch) {
      // Through the parser rather than spread straight in, so a value out of
      // range is clamped now instead of silently differing until the next load.
      const parsed = parseRemoteAccessSettings(
        serializeRemoteAccessSettings({ ...settings, ...patch }) as Record<string, unknown>,
      );
      for (const warning of parsed.warnings) notice(`remote access settings: ${warning}`);
      settings = parsed.settings;
      options.store.save(settings);
      // Re-arm rather than leave the old deadline: shortening the window has to
      // take effect now, and lengthening it should not close early.
      devices.reschedule();
      armAutoClose();
      publish();
      return settings;
    },

    /**
     * Runs a handover `enable` deferred, once its response is on the wire.
     *
     * Split out rather than done inside `enable` because the reply and the
     * teardown travel over the same socket, and doing them in the wrong order
     * leaves the caller unable to tell success from a dropped connection.
     */
    commitHandover() {
      const handing = pendingHandover;
      if (handing === undefined) return;
      pendingHandover = undefined;
      notice('handing the cockpit over to a container');
      options.requestHandover?.(handing);
    },

    /** True between a contained `enable` and the handover its response defers. */
    handoverPending: () => pendingHandover !== undefined,

    tunnelPort: () => listener?.port,
    tunnelPolicy: () => policy,

    async enable() {
      if (status === 'on' || status === 'starting') return { ok: true };
      status = 'starting';
      failure = undefined;
      publish();

      // Containment has to be in place before the tunnel is, so a contained
      // cockpit hands over instead of starting a tunnel here. The container's
      // own hub turns remote access on once it is serving.
      if (settings.sandbox.enabled && options.contained !== true) {
        if (settings.sandbox.workspaces.length === 0) {
          status = 'failed';
          failure = 'Add at least one workspace before running the cockpit in a container.';
          publish();
          return { ok: false, error: failure };
        }
        if (options.requestHandover === undefined) {
          status = 'failed';
          failure = 'This cockpit cannot hand over to a container.';
          publish();
          return { ok: false, error: failure };
        }
        // Held rather than run: the handover closes the server carrying this
        // very response, so the caller has to hear the answer first.
        pendingHandover = settings;
        return { ok: true };
      }
      let bound: TunnelListener;
      try {
        bound = await options.bindListener();
      } catch (error) {
        status = 'failed';
        failure = `The tunnel listener could not bind: ${error instanceof Error ? error.message : String(error)}`;
        publish();
        return { ok: false, error: failure };
      }
      listener = bound;
      const controller = new AbortController();
      const launching = options.launchTunnel({
        port: bound.port,
        config: settings.tunnel,
        signal: controller.signal,
        acceptOrigin: (origin) => {
          policy = tunnelOriginPolicy(origin);
        },
      });
      const startup = { controller, outcome: launching };
      tunnelStartup = startup;
      const outcome = await launching;
      if (tunnelStartup !== startup || controller.signal.aborted) {
        return { ok: false, error: 'Tunnel startup was cancelled.' };
      }
      tunnelStartup = undefined;
      if (!outcome.ok) {
        await teardown();
        status = 'failed';
        failure = outcome.message;
        notice(`remote access failed: ${outcome.message}`);
        publish();
        return { ok: false, error: outcome.message };
      }
      stopTunnel = outcome.stop;
      // A fresh key pair per tunnel: the QR is the only place its public half
      // travels, so it must not outlive the code that carried it.
      handshake = createHostHandshake();
      publicOrigin = outcome.publicOrigin;
      policy = tunnelOriginPolicy(outcome.publicOrigin);
      startedAt = now();
      status = 'on';
      armAutoClose();
      notice(`remote access on at ${outcome.publicOrigin}`);
      publish();
      return { ok: true };
    },

    disable,

    mintPairing() {
      if (status !== 'on' || publicOrigin === undefined) return undefined;
      const { code, expiresAt } = pairing.mintCode();
      // Both the code and the channel key ride in the fragment, which no
      // browser sends to any server. That keeps the code out of the edge's logs
      // and, more importantly, means the channel key reaches the device without
      // ever passing through the relay it is meant to keep out.
      const key = handshake === undefined ? '' : `&${SEALED_KEY_PARAM}=${encodeURIComponent(handshake.publicKey)}`;
      return {
        code,
        pairUrl: `${publicOrigin}${PAIRING_PAGE_ROUTE}#c=${encodeURIComponent(code)}${key}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    claim(input) {
      const outcome = pairing.claim(input);
      if (outcome.ok) {
        broadcastLocal({ type: REMOTE_PAIRING_REQUEST_TYPE, state: view(undefined, true) });
      }
      return outcome;
    },

    pairingStatus: (requestId) => pairing.status(requestId),

    approve(requestId) {
      const outcome = pairing.approve(requestId);
      if (outcome === 'approved') broadcastLocal({ type: REMOTE_PAIRING_REQUEST_TYPE, state: view(undefined, true) });
      return outcome;
    },

    deny(requestId) {
      const outcome = pairing.deny(requestId);
      if (outcome === 'denied') broadcastLocal({ type: REMOTE_PAIRING_REQUEST_TYPE, state: view(undefined, true) });
      return outcome;
    },

    redeem(requestId) {
      const approved = pairing.consume(requestId);
      if (approved === undefined) return undefined;
      const enrolled = devices.enrol({ userAgent: approved.userAgent });
      publish();
      return { ...enrolled, maxAgeSeconds: cookieMaxAgeSeconds(settings, COOKIE_CEILING_SECONDS) };
    },

    authorize: (token) => devices.verify(token)?.id,

    sessionForPasskey(label) {
      const enrolled = devices.enrol({ userAgent: label });
      publish();
      return { ...enrolled, maxAgeSeconds: cookieMaxAgeSeconds(settings, COOKIE_CEILING_SECONDS) };
    },

    passkeys: () => ({
      support: () => webauthn.support(),
      list: () => options.store.credentials(),
      // Wrapped rather than passed by reference: an unbound method carries
      // whatever `this` the caller happens to have.
      beginRegistration: async (caller, label) => await webauthn.beginRegistration(caller, label),
      finishRegistration: async (ceremonyId, caller, response, label) =>
        await webauthn.finishRegistration(ceremonyId, caller, response, label),
      beginAuthentication: async (caller) => await webauthn.beginAuthentication(caller),
      finishAuthentication: async (ceremonyId, caller, response) =>
        await webauthn.finishAuthentication(ceremonyId, caller, response),
      beginStepUp: async (caller, action) => await webauthn.beginStepUp(caller, action),
      finishStepUp: async (ceremonyId, caller, action, response) =>
        await webauthn.finishStepUp(ceremonyId, caller, action, response),
      forget: (id) => {
        const forgotten = options.store.removeCredential(id);
        if (forgotten) publish();
        return forgotten;
      },
    }),

    // Only meaningful where passkeys are: a quick tunnel has no stable rpID, so
    // there is nothing to step up with and the session cookie is all there is.
    stepUpRequired: () => webauthn.support().supported,

    channelPublicKey: () => handshake?.publicKey,

    openChannel(deviceId, scope, clientPublicKey) {
      const channel = handshake?.accept(clientPublicKey);
      if (channel === undefined) return false;
      channels.set(channelKey(deviceId, scope), channel);
      return true;
    },

    channelFor: (deviceId, scope) => channels.get(channelKey(deviceId, scope)),

    revokeDevice(id) {
      const revoked = devices.revoke(id);
      if (revoked) publish();
      return revoked;
    },

    trackSocket(deviceId, close) {
      const held = sockets.get(deviceId) ?? new Set();
      held.add(close);
      sockets.set(deviceId, held);
      return () => {
        held.delete(close);
        if (held.size === 0) sockets.delete(deviceId);
      };
    },

    async close() {
      clearInterval(sweeper);
      await teardown();
      status = 'off';
    },
  };
}
