import type { BashRunResult } from '../../types/bashRunService.ts';
import {
  formatRunResult as formatBashRunResult,
  type ResultBudget,
  type ToolResult,
} from '../../services/bashResult.ts';
import { summarizeLog } from '../../adapters/LogReader/LogReader.ts';

export * from '../../commands/bash/bashTool';

export function formatRunResult(result: BashRunResult, budget: ResultBudget = {}): ToolResult {
  return formatBashRunResult(result, budget, summarizeLog);
}
