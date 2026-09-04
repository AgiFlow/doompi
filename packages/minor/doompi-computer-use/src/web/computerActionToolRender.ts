import type { MessageLine } from '@agimon-ai/doompi-web-components';
import { type ToolResultView, toolResultTextLines } from '@agimon-ai/doompi-web-contracts';

export const computerActionToolName = 'computer_action' as const;
export const computerActionCollapsedLines = 8;

export function computerActionCallSummary(args: Readonly<Record<string, unknown>>): string {
  const kind = typeof args.kind === 'string' ? args.kind : '';
  const ref = typeof args.elementRef === 'string' ? args.elementRef : '';
  return [kind, ref].filter(Boolean).join(' ');
}

/**
 * The body as toned lines: what the result's details say, or its text. Pure,
 * so a unit test can pin it without a DOM; the item decides how many to show.
 */
export function computerActionResultLines(result: ToolResultView | null): MessageLine[] {
  if (result === null) return [];
  return toolResultTextLines(result.content).map((text) => ({ text, tone: 'dim' }));
}
