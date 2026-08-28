import type { DoomTraceContext } from '@agimon-ai/doompi-telemetry';
import type { AuthRuntime } from './auth.ts';
import type { MigratingSession, RemoteAccessSettings, TunnelLauncher } from './remoteAccess.ts';
import type { BridgeStatusFrame, SessionFrame } from './session.ts';

/** One live attachment to a doompi-server socket. */
export interface SessionAttachment {
  /** Forwards a command frame to the agent. Ignored once closed. */
  send(frame: SessionFrame): void;
  close(): void;
}

export interface AttachmentHandlers {
  onFrame(frame: SessionFrame): void;
  onStatus(status: BridgeStatusFrame): void;
}

export interface AttachOptions {
  socketPath: string;
  token: string;
  handlers: AttachmentHandlers;
  trace?: DoomTraceContext;
}

export interface WebServerOptions {
  port: number;
  /** Loopback by default; the socket token is not a browser credential. */
  host?: string;
  /** Directory holding the built SPA. Defaults to the bundled dist/web. */
  assetsDir?: string;
  onNotice?: (message: string) => void;
  /** Watch this registry directory for running sessions. */
  registryDir: string;
  /** Command launching created sessions; overridable so tests can stand in a fake. */
  spawnCommand?: string;
  /** Provider auth runtime; overridable so tests can stand in a fake for Pi's ModelRuntime. */
  authRuntime?: () => Promise<AuthRuntime>;
  /** Where remote-access settings and the tunnel pid file live; defaults to ~/.doompi/web. */
  remoteStateDir?: string;
  /** Explicit cloudflared binary; the default is resolved from the environment and PATH. */
  cloudflaredPath?: string;
  /**
   * Called when the cockpit is asked to hand over to a container.
   *
   * The launcher owns the sequence, because handing over closes this server and
   * a server cannot close itself from inside a request. The sessions are the
   * ones already stopped here and waiting to be recreated on the other side.
   */
  onHandover?: (handover: { settings: RemoteAccessSettings; sessions: readonly MigratingSession[] }) => void;
  /**
   * Overrides the directory the picker is pinned to while remote access is on.
   *
   * Defaults to the process working directory, which is what a launcher gives
   * it; declared so a test does not have to move the whole process.
   */
  browseRoot?: string;
  /** Test seams for remote access, so a suite never spawns a real tunnel or waits on a real clock. */
  remoteAccess?: {
    launchTunnel?: TunnelLauncher;
    now?: () => number;
  };
}

export interface WebServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}
