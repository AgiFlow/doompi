import type { MessageLine } from '@agimon-ai/doompi-web-components';
import { type ToolResultView, toolResultTextLines } from '@agimon-ai/doompi-web-contracts';

export const computerStateToolName = 'computer_state' as const;
export const computerStateCollapsedLines = 8;

export function computerStateCallSummary(_args: Readonly<Record<string, unknown>>): string {
  return 'authorized window';
}

/**
 * The body as toned lines: what the result's details say, or its text. Pure,
 * so a unit test can pin it without a DOM; the item decides how many to show.
 */
export function computerStateResultLines(result: ToolResultView | null): MessageLine[] {
  if (result === null) return [];
  return toolResultTextLines(result.content).map((text) => ({ text, tone: 'dim' }));
}
