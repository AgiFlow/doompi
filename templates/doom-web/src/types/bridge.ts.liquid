import type { AuthRuntime } from './auth.ts';
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
}

export interface WebServerOptions {
  port: number;
  /** Loopback by default; the socket token is not a browser credential. */
  host?: string;
  /** Directory holding the built SPA. Defaults to the bundled dist/web. */
  assetsDir?: string;
  onNotice?: (message: string) => void;
  /** Hub mode: watch this registry directory for running sessions. */
  registryDir?: string;
  /** Fixed single-session mode: dial exactly this socket. */
  socketPath?: string;
  /** Fixed single-session mode: the attach token for that socket. */
  token?: string;
  /** Hub mode: command launching created sessions; overridable so tests can stand in a fake. */
  spawnCommand?: string;
  /** Provider auth runtime; overridable so tests can stand in a fake for Pi's ModelRuntime. */
  authRuntime?: () => Promise<AuthRuntime>;
}

export interface WebServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}
