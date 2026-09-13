import type { ToolRendererContribution } from '@agimon-ai/doompi-core/web';

import { RunWorktreeToolMessage } from './RunWorktreeToolMessage';

/** The timeline items for this package's tools. */
export const gitToolRenderers: ToolRendererContribution[] = [
  { tools: ['run_worktree'], message: RunWorktreeToolMessage },
];
