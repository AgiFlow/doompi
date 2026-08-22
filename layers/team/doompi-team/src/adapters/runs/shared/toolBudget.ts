/**
 * Tool-call budget validation, enforcement predicates and its process handoff.
 *
 * DESIGN PATTERNS:
 * - Pure functions over a resolved budget; the running tool count is the
 *   caller's, so this module has nothing to reset between runs
 * - The budget crosses into the child as one JSON environment value, encoded and
 *   decoded here, so parent and child can never disagree about its shape
 *
 * WHY BLOCKING IS NARROWED TO A TOOL LIST:
 * The point of the hard limit is to stop open-ended browsing and searching, not
 * to strand a child that still has to write its answer. Blocking only the
 * read-style tools leaves `edit`, `write` and the reporting path available past
 * the limit, so an over-budget child finishes rather than fails.
 *
 * AVOID:
 * - Blocking on the call that reaches the hard limit; the count must exceed it
 *   first, so the budgeted number of calls actually happens
 * - Reading the environment variable name from anywhere but `src/env.ts`
 */

import { TOOL_BUDGET_ENV } from '../../../types/environment';
import type { ToolBudgetConfig } from '../../../types';

/** A tool budget with its block list settled. */
export interface ResolvedToolBudget {
  soft?: number;
  hard: number;
  block: string[] | '*';
}

/** How a run stands against its tool budget. */
export type ToolBudgetOutcome = 'within-budget' | 'soft-reached' | 'hard-blocked';

/** The budget plus everything observed about it during one run. */
export interface ToolBudgetState extends ResolvedToolBudget {
  outcome: ToolBudgetOutcome;
  toolCount: number;
  softReachedAt?: number;
  hardReachedAt?: number;
  blockedTool?: string;
}

/**
 * Blocked by default: the read-style tools a child loops on when it is stuck.
 *
 * Deliberately excludes `edit` and `write` so an over-budget child can still
 * land the work it has already reasoned about.
 */
export const DEFAULT_TOOL_BUDGET_BLOCK = ['read', 'grep', 'find', 'ls'] as const;

const BLOCK_ALL_TOOLS = '*';
const MIN_SOFT_LIMIT = 1;
const DEFAULT_MINIMUM_HARD_LIMIT = 1;

/** Deduplicate and trim an authored block list, or pass through the block-all marker. */
export function normalizeToolBudgetBlock(block: ToolBudgetConfig['block'] | undefined): '*' | string[] {
  if (block === BLOCK_ALL_TOOLS) return BLOCK_ALL_TOOLS;
  if (block === undefined) return [...DEFAULT_TOOL_BUDGET_BLOCK];
  return [...new Set(block.map((tool) => tool.trim()).filter(Boolean))];
}

/**
 * Validate an authored tool budget and settle its block list.
 *
 * `minimumHard` is 0 only for the zero-authorised path, where a caller has
 * explicitly asked for a budget that blocks every tool from the first call.
 */
export function validateToolBudgetConfig(
  raw: unknown,
  label = 'toolBudget',
  options: { minimumHard?: 0 | 1 } = {},
): { budget?: ResolvedToolBudget; error?: string } {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `${label} must be an object with hard and optional soft/block.` };
  }
  const value: Record<string, unknown> = raw as Record<string, unknown>;
  const minimumHard = options.minimumHard ?? DEFAULT_MINIMUM_HARD_LIMIT;

  const hard = value.hard;
  if (typeof hard !== 'number' || !Number.isInteger(hard) || hard < minimumHard) {
    return { error: `${label}.hard must be an integer >= ${minimumHard}.` };
  }
  const soft = value.soft;
  if (soft !== undefined && (typeof soft !== 'number' || !Number.isInteger(soft) || soft < MIN_SOFT_LIMIT)) {
    return { error: `${label}.soft must be an integer >= ${MIN_SOFT_LIMIT} when provided.` };
  }
  if (soft !== undefined && soft > hard) {
    return { error: `${label}.soft must be <= ${label}.hard.` };
  }

  const rawBlock = value.block;
  let block: ToolBudgetConfig['block'] | undefined;
  if (rawBlock !== undefined && rawBlock !== BLOCK_ALL_TOOLS) {
    if (!Array.isArray(rawBlock)) return { error: `${label}.block must be "*" or an array of tool names.` };
    if (rawBlock.length === 0) return { error: `${label}.block must contain at least one tool name.` };
    for (const item of rawBlock) {
      if (typeof item !== 'string' || !item.trim()) {
        return { error: `${label}.block must contain non-empty tool names.` };
      }
    }
    block = rawBlock as string[];
  } else {
    block = rawBlock;
  }

  return {
    budget: {
      hard,
      ...(soft !== undefined ? { soft } : {}),
      block: normalizeToolBudgetBlock(block),
    },
  };
}

export function initialToolBudgetState(budget: ResolvedToolBudget): ToolBudgetState {
  return { ...budget, toolCount: 0, outcome: 'within-budget' };
}

export function toolBudgetState(budget: ResolvedToolBudget, toolCount: number, blockedTool?: string): ToolBudgetState {
  const overHard = toolCount > budget.hard;
  const overSoft = budget.soft !== undefined && toolCount >= budget.soft;
  return {
    ...budget,
    toolCount,
    outcome: overHard ? 'hard-blocked' : overSoft ? 'soft-reached' : 'within-budget',
    ...(overSoft ? { softReachedAt: budget.soft } : {}),
    ...(overHard ? { hardReachedAt: budget.hard, blockedTool } : {}),
  };
}

/**
 * Whether this call must be refused.
 *
 * `nextToolCount` is the count including the call being decided, so the budgeted
 * number of calls runs and only the one after it is refused.
 */
export function shouldBlockToolForBudget(budget: ResolvedToolBudget, toolName: string, nextToolCount: number): boolean {
  if (nextToolCount <= budget.hard) return false;
  return budget.block === BLOCK_ALL_TOOLS || budget.block.includes(toolName);
}

export function toolBudgetSoftNudge(budget: ResolvedToolBudget, toolCount: number): string {
  return `Tool budget soft limit reached after ${toolCount} tool call${toolCount === 1 ? '' : 's'} (soft ${budget.soft}, hard ${budget.hard}). Stop starting new browsing/search work and finalize from the context you already have.`;
}

export function toolBudgetBlockedMessage(budget: ResolvedToolBudget, toolName: string, toolCount: number): string {
  return `Tool budget hard limit reached after ${toolCount} tool call${toolCount === 1 ? '' : 's'} (hard ${budget.hard}). The '${toolName}' tool is blocked so you can finalize from the context you already have.`;
}

export function encodeToolBudgetEnv(budget: ResolvedToolBudget | undefined): string | undefined {
  return budget ? JSON.stringify(budget) : undefined;
}

/**
 * Read the budget a parent handed to this child.
 *
 * Throws rather than returning an error string: an unreadable budget means the
 * child cannot know what it is allowed to do, and running unbudgeted would
 * silently defeat the cap the parent set.
 */
export function decodeToolBudgetEnv(
  value: string | undefined,
  options: { allowZero?: boolean } = {},
): ResolvedToolBudget | undefined {
  if (!value?.trim()) return undefined;
  const parsed: unknown = JSON.parse(value);
  const normalized = validateToolBudgetConfig(
    parsed,
    TOOL_BUDGET_ENV,
    options.allowZero ? { minimumHard: 0 } : undefined,
  );
  if (normalized.error) throw new Error(normalized.error);
  return normalized.budget;
}
