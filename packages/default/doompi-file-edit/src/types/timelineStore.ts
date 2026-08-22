import type { FileEditEntry, TimelineEvent } from './domain';

export interface ITimelineStore {
  initialize(filePath: string): void;
  append(event: TimelineEvent): Promise<void>;
  list(): Promise<FileEditEntry[]>;
  clear(): Promise<void>;
}
