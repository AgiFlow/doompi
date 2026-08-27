import type { FileEditEntry, FileEditVersion, TimelineEvent } from './domain';

export interface ITimelineStore {
  initialize(filePath: string): void;
  append(event: TimelineEvent): Promise<void>;
  list(): Promise<FileEditEntry[]>;
  /** One file's history, oldest first; empty when the session never touched it. */
  versions(filePath: string): Promise<FileEditVersion[]>;
  clear(): Promise<void>;
}
