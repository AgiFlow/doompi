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

export interface BundlePairingTrust {
  publicKey: string;
  fingerprint: string;
  revision: number;
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
