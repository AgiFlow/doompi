import { type ResultBudget, type ToolResult } from '../../types/bashResult';
import type { BashRunResult } from '../../types/bashRunService';
import { formatRunResult as formatBashRunResult } from '../bashResult';
import { summarizeLog } from '../logReader';

export function formatRunnerResult(result: BashRunResult, budget: ResultBudget = {}): ToolResult {
  return formatBashRunResult(result, budget, summarizeLog);
}
