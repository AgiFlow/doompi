import type { ToolRendererContribution } from '@agimon-ai/doompi-web-contracts';
import { IntercomToolMessage } from './IntercomToolMessage.tsx';
import { SubagentToolMessage } from './SubagentToolMessage.tsx';

/**
 * The timeline items for this package's tools. structured_output is left
 * out on purpose: it is registered only inside subagent child processes,
 * whose transcripts never reach this session's timeline.
 */
export const teamToolRenderers: ToolRendererContribution[] = [
  { tools: ['subagent'], message: SubagentToolMessage },
  { tools: ['intercom'], message: IntercomToolMessage },
];
