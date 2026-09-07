import type { ToolRendererContribution } from '@agimon-ai/doompi-web-contracts';
import { RunWorktreeToolMessage } from './RunWorktreeToolMessage.tsx';

/** The timeline items for this package's tools. */
export const gitToolRenderers: ToolRendererContribution[] = [
  { tools: ['run_worktree'], message: RunWorktreeToolMessage },
];
