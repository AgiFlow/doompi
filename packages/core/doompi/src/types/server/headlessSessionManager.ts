import type { HeadlessSessionHost, HeadlessSessionHostOptions } from './headlessSessionHost.ts';

export interface HeadlessSessionManagerCreateOptions extends HeadlessSessionHostOptions {
  signal?: AbortSignal;
}

export interface HeadlessSessionManager {
  create(options: HeadlessSessionManagerCreateOptions): Promise<HeadlessSessionHost>;
  get(sessionId: string): HeadlessSessionHost | undefined;
  sessions(): readonly HeadlessSessionHost[];
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
