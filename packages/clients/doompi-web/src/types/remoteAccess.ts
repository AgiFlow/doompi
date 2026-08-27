/**
 * Wire vocabulary for remote access, shared by the hub routes and the cockpit.
 *
 * Remote access binds a second loopback listener that a tunnel points at, and
 * everything arriving there must prove it holds a paired session. The
 * discriminator is the listening socket, not a header: a tunnel connects from
 * 127.0.0.1 like every local client, and there is no header a remote caller
 * cannot forge.
 */

/** REST surface for the remote-access control plane; local callers only, except turn-off and revoke. */
export const REMOTE_API_ROUTE = '/api/remote';
/** Direct endpoint that establishes one scoped end-to-end channel. */
export const REMOTE_CHANNEL_ROUTE = `${REMOTE_API_ROUTE}/channel`;
/** The only authenticated HTTP gateway exposed on the tunnel listener. */
export const REMOTE_HTTP_ROUTE = `${REMOTE_API_ROUTE}/request`;
export const SESSION_SOCKET_ROUTE = '/api/session';
export const PROTOCOL_SOCKET_ROUTE = '/api/pi';
/** The pairing page a scanned QR opens. Unauthenticated on the tunnel listener. */
export const PAIRING_PAGE_ROUTE = '/pair';
/** Where the pairing page posts the scanned code. Unauthenticated on the tunnel listener. */
export const PAIRING_CLAIM_ROUTE = '/api/remote/pair';
/** Polled until the host approves or denies. Unauthenticated on the tunnel listener. */
export const PAIRING_STATUS_ROUTE = '/api/remote/pair/status';
/** Query parameter naming the pairing request; a path parameter would force a wildcard into the allowlist. */
export const PAIRING_STATUS_QUERY = 'request';

/**
 * Session cookie base name. Rendered `__Host-doompi_device` by hono's `host`
 * prefix, which refuses the cookie unless it is Secure, Path=/, and
 * Domain-less, so a sibling subdomain can neither read nor overwrite it.
 */
export const DEVICE_COOKIE = 'doompi_device';

/**
 * Passkey sign-in, reachable without a session on the tunnel listener.
 *
 * It has to be: proving a registered passkey is how a returning device gets a
 * session in the first place, so gating these behind one would mean a passkey
 * could never be used and every visit would need another QR.
 */
export const PASSKEY_AUTH_BEGIN_ROUTE = '/api/remote/passkeys/authenticate/begin';
export const PASSKEY_AUTH_FINISH_ROUTE = '/api/remote/passkeys/authenticate/finish';

/** Header carrying a step-up assertion for an action that needs more than a live session. */
export const STEP_UP_HEADER = 'x-doompi-assertion';

/** The vite dev server port; the origin allowlist and vite.config.ts share this. */
export const WEB_DEV_SERVER_PORT = 7434;

/** How long a scanned pairing code stays claimable. */
export const PAIRING_CODE_TTL_MS = 120_000;
/** How long the host has to approve or deny a claimed request. */
export const PAIRING_REQUEST_TTL_MS = 180_000;
/** Cookie lifetime when session expiry is switched off; a session cookie can outlive the laptop. */
export const COOKIE_CEILING_SECONDS = 30 * 24 * 60 * 60;

export type TunnelKind = 'quick' | 'named';
export type RemoteChannelScope = 'session' | 'protocol' | 'http';

/**
 * How the tunnel is established.
 *
 * `named` carries a hostname rather than discovering one, which is why it is
 * the mode that supports passkeys, a service worker, and durable pairing: all
 * three are bound to the origin, and a quick tunnel's hostname rotates on every
 * start. The token is referenced by path, never stored inline, because it is a
 * Cloudflare account credential and an inlined one ends up in a bug report.
 */
export type TunnelConfig =
  | { kind: 'quick' }
  | { kind: 'named'; hostname: string; name?: string; tokenFile?: string; configFile?: string };

/**
 * Running the cockpit in a container.
 *
 * Tied to remote access rather than offered separately: the reason to contain
 * the cockpit is that a paired device drives an agent holding a shell, and the
 * containment only means anything if it is in place before the tunnel is.
 *
 * The workspace list is the boundary. A hub inside the container cannot create
 * a session in a path that is not mounted, so arbitrary-directory spawning is
 * closed by construction rather than by a check.
 */
export interface SandboxSettings {
  enabled: boolean;
  /** Absolute host directories the contained cockpit may work in. */
  workspaces: string[];
}

/**
 * A session the handover has to account for.
 *
 * Only what recreating it needs: the container hub spawns a fresh server, so
 * nothing about the host process survives the move.
 */
export interface MigratingSession {
  id: string;
  cwd: string;
  name?: string;
}

/** Nullable numbers are not used: a disabled toggle keeps its value so flipping it back restores it. */
export interface RemoteAccessSettings {
  /** Close the tunnel on a timer. */
  autoCloseEnabled: boolean;
  autoCloseMinutes: number;
  /** Expire paired sessions on idle and on total age. */
  sessionExpiryEnabled: boolean;
  idleMinutes: number;
  absoluteHours: number;
  tunnel: TunnelConfig;
  sandbox: SandboxSettings;
}

export type RemoteAccessStatus = 'off' | 'starting' | 'on' | 'failed';

export interface PairedDeviceView {
  id: string;
  label: string;
  userAgent: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  lastSeenAt: string;
  /** True for the device making the request, so the UI can say "this device". */
  self: boolean;
}

export interface PairingRequestView {
  id: string;
  userAgent: string;
  /**
   * The address Cloudflare's edge reported. Display only: any local process can
   * reach the tunnel listener directly and set this header to anything, so it
   * never gates a decision. The UI labels it "reported by the edge".
   */
  edgeIp: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface RemoteAccessStateView {
  status: RemoteAccessStatus;
  /** Present once the tunnel reports its hostname. */
  publicUrl?: string;
  /** ISO 8601, present while the tunnel is up. */
  startedAt?: string;
  /** ISO 8601, absent when auto-close is switched off. */
  closesAt?: string;
  /** Why the tunnel failed, once it has. */
  error?: string;
  devices: PairedDeviceView[];
  /** Populated for local callers only; a paired phone must not see approval prompts. */
  pending: PairingRequestView[];
  settings: RemoteAccessSettings;
}

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';

export type TunnelFailure = 'not_installed' | 'spawn_failed' | 'timeout' | 'self_test_failed' | 'exited';

export interface TunnelStartInput {
  /** The loopback port the tunnel should publish. */
  port: number;
  config: TunnelConfig;
  /** Arms the exact public origin before the launcher probes through it. */
  acceptOrigin?: (origin: string) => void;
  /** Cancels startup and asks the launcher to stop any process it has spawned. */
  signal?: AbortSignal;
}

export type TunnelStartResult =
  | { ok: true; publicOrigin: string; stop: () => Promise<void> }
  | { ok: false; failure: TunnelFailure; message: string };

/**
 * Starting a tunnel, as a port rather than a concrete process.
 *
 * Declared here so a test can inject a fake without pulling in the cloudflared
 * adapter, and so `WebServerOptions` can name the seam without reaching across
 * a layer to do it.
 */
export type TunnelLauncher = (input: TunnelStartInput) => Promise<TunnelStartResult>;

/** Hub frame announcing remote-access state; sent to local and remote pages. */
export const REMOTE_STATE_TYPE = 'remote_state';
/** Hub frame announcing a device waiting for approval; sent to local pages only. */
export const REMOTE_PAIRING_REQUEST_TYPE = 'remote_pairing_request';
