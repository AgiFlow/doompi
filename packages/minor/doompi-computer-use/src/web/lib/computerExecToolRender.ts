import type { MessageLine } from '@agimon-ai/doompi-web-components';
import { type ToolResultView, toolResultTextLines } from '@agimon-ai/doompi-core/web';

export const computerExecToolName = 'computer_exec' as const;
export const computerExecCollapsedLines = 8;

export function computerExecCallSummary(args: Readonly<Record<string, unknown>>): string {
  return typeof args.scriptPath === 'string' ? args.scriptPath : '';
}

export function computerExecResultLines(result: ToolResultView | null): MessageLine[] {
  if (result === null) return [];
  return toolResultTextLines(result.content).map((text) => ({ text, tone: 'dim' }));
}
