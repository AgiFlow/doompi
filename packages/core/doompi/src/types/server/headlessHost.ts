import type { DoomServerBundleEntry } from '@agimon-ai/doompi-extension-contracts/server-facet';
import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessSelection,
  DoomHeadlessTool,
  DoomHeadlessResource,
} from '@agimon-ai/doompi-extension-contracts/headless';

export type ResolvedHeadlessResource = Pick<DoomHeadlessResource, 'name' | 'kind'> & { source: string; text: string };

export interface HeadlessHostOptions {
  candidates: readonly DoomServerBundleEntry[];
  selection: DoomHeadlessSelection;
  context(selection: DoomHeadlessSelection): DoomHeadlessExecutionContext;
  applyTools(tools: readonly DoomHeadlessTool[]): void | Promise<void>;
  applyResources(resources: readonly ResolvedHeadlessResource[]): void | Promise<void>;
  validateSelection?(selection: DoomHeadlessSelection): void | Promise<void>;
  allowedTools?(selection: DoomHeadlessSelection): readonly string[] | undefined;
  onApplied?(selection: DoomHeadlessSelection, revision: number): void | Promise<void>;
  onError?(error: unknown): void;
}

export interface HeadlessSelectionStatus {
  requestedRevision: number;
  appliedRevision: number;
  ready: boolean;
  error?: string;
}
