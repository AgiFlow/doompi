import type { Context } from '@deepseek-ai/cordis';

import type { DoomHeadlessSelection } from '../../../exports/headless';
import type { LoadedMcpPlugin } from '../../../exports/mcpFacet';
import type { DoomWebComposition } from '../../../exports/packageApi';
import type { InstalledServerFacets } from '../../../exports/serverFacet';
import type { DoomServerBundleEntry } from '../../../exports/serverFacet';
import type { ContextProjectionInput } from '../../../services/contextProjection';
import type { SyncRegistration } from '../../../services/syncRegistration';
import type { DirectHarnessRuntime } from '../../../types/server/directHarnessRuntime';
import type { SessionToolSurface } from '../../../types/server/sessionToolSurface';
import type { HeadlessHost } from '../adapters/headlessHost';
import type { HeadlessHostOptions } from './headlessHost';

export interface HeadlessSessionHostOptions {
  cwd: string;
  repoRoot: string;
  sessionId: string;
  workspaceId?: string;
  /** Parent workspace location used for grouping, not for session execution. */
  groupingRoot?: string;
  /** Pinned parent generation required to reopen an inherited worktree journal. */
  inheritedArtifact?: SyncRegistration;
  webComposition?: DoomWebComposition;
  sessionName: string;
  parentSessionId?: string;
  sessionProvenance?: string;
  agentArgs: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  selection: DoomHeadlessSelection;
  selectionOverrides?: readonly ('majorMode' | 'domains' | 'profile')[];
  inheritedSelection?: () => Partial<DoomHeadlessSelection> | Promise<Partial<DoomHeadlessSelection>>;
  candidates: readonly DoomServerBundleEntry[];
  /** Explicit remote-only plugins loaded from the admitted MCP bundle. */
  mcpPlugins?: readonly LoadedMcpPlugin[];
  resolveSelection?: HeadlessHostOptions['resolveSelection'];
  publishSelectionStatus?: (
    setStatus: (source: string, text: string | undefined) => void,
    selection: DoomHeadlessSelection,
  ) => void;
  contextGroups?: (context: Context, selection: DoomHeadlessSelection) => ContextProjectionInput['groups'];
  onNotice?: (message: string) => void;
  /**
   * Load Pi native extensions from the synced composition. Defaults to enabled and resolves to
   * a no-op when the worktree has no valid sync registration.
   */
  piExtensions?: boolean;
  /** Exact admitted bootstrap paths, used when a child inherits another worktree's generation. */
  piExtensionPaths?: readonly string[];
}

export interface HeadlessSessionHost {
  readonly runtime: DirectHarnessRuntime;
  readonly host: HeadlessHost | undefined;
  readonly toolSurface: SessionToolSurface;
  readonly mcpSurface: SessionToolSurface;
  readonly prepareFacets: (root: Context) => void;
  readonly activateFacets: (installed: InstalledServerFacets) => Promise<void>;
  readonly canDispatch: () => boolean;
  onPresentationFrame(listener: (frame: Record<string, unknown>) => void): () => void;
  respondToExtensionUi(frame: Record<string, unknown>): boolean;
  dispose(): Promise<void>;
}
