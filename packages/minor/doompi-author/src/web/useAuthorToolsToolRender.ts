import type { MessageLine } from '@agimon-ai/doompi-web-components';
import { type ToolResultView, toolResultTextLines } from '@agimon-ai/doompi-web-contracts';

export const useAuthorToolsToolName = 'use_author_tools';

/** Lines the collapsed item shows before it expands. */
export const useAuthorToolsCollapsedLines = 8;

export function useAuthorToolsCallSummary(args: Readonly<Record<string, unknown>>): string {
  return typeof args.name === 'string' ? args.name : '';
}

/**
 * The body as toned lines: what the result's details say, or its text. Pure,
 * so a unit test can pin it without a DOM; the item decides how many to show.
 */
export function useAuthorToolsResultLines(result: ToolResultView | null): MessageLine[] {
  if (result === null) return [];
  return toolResultTextLines(result.content).map((text) => ({ text, tone: 'dim' }));
}
