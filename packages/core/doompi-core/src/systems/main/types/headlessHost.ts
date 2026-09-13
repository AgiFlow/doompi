import type {
  DoomHeadlessExecutionContext,
  DoomHeadlessSelection,
  DoomHeadlessTool,
  DoomHeadlessResource,
} from '../../../exports/headless';
import type { DoomServerBundleEntry } from '../../../exports/serverFacet';
import type { PackageAttribution } from '../../../services/contextProjection';
import type { ContextSkillInventory, ContextToolSource } from '../../../services/contextProjection';

export type ResolvedHeadlessResource = Pick<DoomHeadlessResource, 'name' | 'kind'> & {
  source: string;
  text: string;
};

export interface HeadlessContextInventory {
  readonly sources: readonly ContextToolSource[];
  readonly skills: readonly ContextSkillInventory[];
  readonly attribution: Readonly<Record<string, PackageAttribution>>;
}

export interface HeadlessHostOptions {
  candidates: readonly DoomServerBundleEntry[];
  selection: DoomHeadlessSelection;
  selectionOverrides?: readonly ('majorMode' | 'domains' | 'profile')[];
  context(selection: DoomHeadlessSelection): DoomHeadlessExecutionContext;
  applyTools(tools: readonly DoomHeadlessTool[]): void | Promise<void>;
  applyResources(resources: readonly ResolvedHeadlessResource[]): void | Promise<void>;
  resolveSelection?(selection: DoomHeadlessSelection): DoomHeadlessSelection | Promise<DoomHeadlessSelection>;
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
