import type { ToolRendererContribution } from '@agimon-ai/doompi-web-contracts';
import { IntercomCall, IntercomResult } from './IntercomToolCard.tsx';
import { SubagentCall, SubagentResult } from './SubagentToolCard.tsx';

/**
 * The timeline cards for this package's tools. structured_output is left
 * out on purpose: it is registered only inside subagent child processes,
 * whose transcripts never reach this session's timeline.
 */
export const teamToolRenderers: ToolRendererContribution[] = [
  { tools: ['subagent'], call: SubagentCall, result: SubagentResult },
  { tools: ['intercom'], call: IntercomCall, result: IntercomResult },
];
