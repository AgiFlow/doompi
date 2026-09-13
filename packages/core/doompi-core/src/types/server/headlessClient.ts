import type { DoomHeadlessClient } from '../../exports/headless';

export interface HeadlessClientOptions {
  emitFrame(frame: Record<string, unknown>): void;
  appendCustomEntry(type: string, data: unknown): Promise<void>;
}

export interface HeadlessClientBridge {
  readonly client: DoomHeadlessClient;
  receive(frame: Record<string, unknown>): boolean;
  dispose(): void;
}

export interface PendingClientRequest {
  start(): void;
  respond(frame: Record<string, unknown>): void;
  close(): void;
}
