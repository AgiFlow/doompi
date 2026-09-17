import type { Context } from '@deepseek-ai/cordis';

import type { DoomHeadlessSelection } from '../../../exports/headless';
import type { DoomWebComposition } from '../../../exports/packageApi';
import type { InstalledServerFacets } from '../../../exports/serverFacet';
import type { DoomServerBundleEntry } from '../../../exports/serverFacet';
import type { ContextProjectionInput } from '../../../services/contextProjection';
import type { DirectHarnessRuntime } from '../../../types/server/directHarnessRuntime';
import type { SessionToolSurface } from '../../../types/server/sessionToolSurface';
import type { HeadlessHost } from '../adapters/headlessHost';
import type { HeadlessHostOptions } from './headlessHost';

export interface HeadlessSessionHostOptions {
  cwd: string;
  repoRoot: string;
  sessionId: string;
  workspaceId?: string;
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
}

export interface HeadlessSessionHost {
  readonly runtime: DirectHarnessRuntime;
  readonly host: HeadlessHost | undefined;
  readonly toolSurface: SessionToolSurface;
  readonly prepareFacets: (root: Context) => void;
  readonly activateFacets: (installed: InstalledServerFacets) => Promise<void>;
  readonly canDispatch: () => boolean;
  onPresentationFrame(listener: (frame: Record<string, unknown>) => void): () => void;
  respondToExtensionUi(frame: Record<string, unknown>): boolean;
  dispose(): Promise<void>;
}
