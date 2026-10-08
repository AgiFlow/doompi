import type { Context } from '@deepseek-ai/cordis';

import type { DoomHeadlessSelection } from '../../../exports/headless';
import type { DoomSessionContext } from '../../../exports/hubChannel';
import type { LoadedMcpPlugin } from '../../../exports/mcpFacet';
import type { DoomWebComposition } from '../../../exports/packageApi';
import type { InstalledServerFacets } from '../../../exports/serverFacet';
import type { DoomServerBundleEntry } from '../../../exports/serverFacet';
import type { ContextProjectionInput } from '../../../services/contextProjection';
import type { ServerTelemetry } from '../../../services/serverTelemetry';
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
  /** Creation-only Fast snapshot. Restored session state takes precedence. */
  initialFastMode?: boolean;
  /** Creation-only agent lock. Restored session state takes precedence. */
  initialAgentLocked?: boolean;
  parentSessionId?: string;
  sessionProvenance?: string;
  agentArgs: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  selection: DoomHeadlessSelection;
  selectionOverrides?: readonly ('majorMode' | 'domains' | 'profile')[];
  /** The only tools the agent may see or call, whatever the selection and packages contribute. */
  allowedTools?: readonly string[];
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
  telemetry?: Pick<ServerTelemetry, 'recordError'>;
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
  /** Built once from the host options; absent only for a host that was given no workspace. */
  readonly sessionContext?: DoomSessionContext;
  readonly host: HeadlessHost | undefined;
  readonly toolSurface: SessionToolSurface;
  readonly mcpSurface: SessionToolSurface;
  readonly prepareFacets: (root: Context) => void;
  readonly activateFacets: (installed: InstalledServerFacets) => Promise<void>;
  readonly canDispatch: () => boolean;
  onPresentationFrame(listener: (frame: Record<string, unknown>) => void): () => void;
  /** Replays the latest selection, then reports each applied change. Optional so lightweight hosts can omit it. */
  onSelection?(listener: (selection: DoomHeadlessSelection) => void): () => void;
  respondToExtensionUi(frame: Record<string, unknown>): boolean;
  dispose(): Promise<void>;
}
