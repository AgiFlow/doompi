import type { HeadlessSessionHost, HeadlessSessionHostOptions } from './headlessSessionHost';

export interface HeadlessSessionManagerCreateOptions extends HeadlessSessionHostOptions {
  signal?: AbortSignal;
}

export interface HeadlessSessionCloseOptions {
  /** Keep the session's record, so it lists as dormant: readable, and able to be woken. */
  readonly keepDormant?: boolean;
}

export interface HeadlessSessionManager {
  create(options: HeadlessSessionManagerCreateOptions): Promise<HeadlessSessionHost>;
  get(sessionId: string): HeadlessSessionHost | undefined;
  sessions(): readonly HeadlessSessionHost[];
  closeSession(sessionId: string, options?: HeadlessSessionCloseOptions): Promise<void>;
  close(): Promise<void>;
}
