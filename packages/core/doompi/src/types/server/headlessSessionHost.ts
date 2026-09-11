import type { Context } from '@deepseek-ai/cordis';
import type { InstalledServerFacets } from '@agimon-ai/doompi-extension-contracts/server-facet-loader';
import type { DoomHeadlessSelection } from '@agimon-ai/doompi-extension-contracts/headless';
import type { DoomServerBundleEntry } from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { HeadlessHost } from '../../adapters/server/headlessHost';
import type { DirectHarnessRuntime } from './directHarnessRuntime';
import type { AgentProcess } from './session';
import type { HeadlessHostOptions } from './headlessHost';

export interface HeadlessSessionHostOptions {
  cwd: string;
  repoRoot: string;
  sessionId: string;
  sessionName: string;
  agentArgs: readonly string[];
  selection: DoomHeadlessSelection;
  candidates: readonly DoomServerBundleEntry[];
  resolveSelection?: HeadlessHostOptions['resolveSelection'];
  onNotice?: (message: string) => void;
}

export interface HeadlessSessionHost {
  readonly agent: AgentProcess;
  readonly runtime: DirectHarnessRuntime;
  readonly host: HeadlessHost | undefined;
  readonly prepareFacets: (root: Context) => void;
  readonly activateFacets: (installed: InstalledServerFacets) => Promise<void>;
  readonly canDispatch: () => boolean;
  dispose(): Promise<void>;
}
