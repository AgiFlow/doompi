import type { DoomWebComposition } from '@agimon-ai/doompi-extension-contracts/package-api';
import type { Context } from '@deepseek-ai/cordis';
import type { InstalledServerFacets } from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { DoomHeadlessSelection } from '@agimon-ai/doompi-extension-contracts/headless';
import type { DoomServerBundleEntry } from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { HeadlessHost } from '../../adapters/server/headlessHost';
import type { DirectHarnessRuntime } from './directHarnessRuntime';
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
  onNotice?: (message: string) => void;
}

export interface HeadlessSessionHost {
  readonly runtime: DirectHarnessRuntime;
  readonly host: HeadlessHost | undefined;
  readonly prepareFacets: (root: Context) => void;
  readonly activateFacets: (installed: InstalledServerFacets) => Promise<void>;
  readonly canDispatch: () => boolean;
  onPresentationFrame(listener: (frame: Record<string, unknown>) => void): () => void;
  respondToExtensionUi(frame: Record<string, unknown>): boolean;
  dispose(): Promise<void>;
}
