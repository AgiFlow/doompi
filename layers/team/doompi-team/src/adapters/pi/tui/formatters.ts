/**
 * Formatting utilities for display output.
 *
 * DESIGN PATTERNS:
 * - Every function here is presentation only. Nothing it returns is parsed back,
 *   so rounding and truncation are free to favour readability
 * - Truncation limits are supplied per call site through the `expanded` flag so a
 *   detail pane and a one-line status row share one implementation
 *
 * AVOID:
 * - Round-tripping these strings; `formatTokens` and `formatDuration` are lossy
 * - Widening the tool-call preview limits without checking the narrowest surface
 *   that renders them
 */

import type { Usage } from '../../../types';
import { splitKnownThinkingSuffix, THINKING_LEVELS } from '../../../services/models/modelInfo';

const TOKENS_PER_K = 1000;
const TOKENS_FRACTIONAL_K_LIMIT = 10000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const COST_DECIMAL_PLACES = 4;
const SECONDS_DECIMAL_PLACES = 1;
const K_DECIMAL_PLACES = 1;
const BASH_PREVIEW_LIMIT = 60;
const BASH_PREVIEW_LIMIT_EXPANDED = 240;
const ARGS_PREVIEW_LIMIT = 40;
const ARGS_PREVIEW_LIMIT_EXPANDED = 160;
const TRUNCATION_ELLIPSIS = '...';
const HOME_SHORTHAND = '~';

/**
 * Format token count with k suffix for large numbers
 */
export function formatTokens(n: number): string {
  if (n < TOKENS_PER_K) return String(n);
  if (n < TOKENS_FRACTIONAL_K_LIMIT) return `${(n / TOKENS_PER_K).toFixed(K_DECIMAL_PLACES)}k`;
  return `${Math.round(n / TOKENS_PER_K)}k`;
}

export function formatModelThinking(model?: string, thinking?: string): string {
  const parsed = model ? splitKnownThinkingSuffix(model) : undefined;
  let displayModel = parsed?.baseModel ?? model;
  const explicitThinking = THINKING_LEVELS.find((level) => level === thinking?.trim());
  // A suffix on the model string is the caller's most specific intent, so it wins
  // over the separately configured level.
  const displayThinking = parsed?.thinkingSuffix ? parsed.thinkingSuffix.slice(1) : explicitThinking;
  if (displayModel) {
    const slashIdx = displayModel.lastIndexOf('/');
    if (slashIdx !== -1) displayModel = displayModel.slice(slashIdx + 1);
  }
  return [displayModel, displayThinking ? `thinking ${displayThinking}` : undefined].filter(Boolean).join(' · ');
}

/**
 * Format usage statistics into a compact string
 */
export function formatUsage(u: Usage, model?: string): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? 's' : ''}`);
  if (u.input) parts.push(`in:${formatTokens(u.input)}`);
  if (u.output) parts.push(`out:${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(COST_DECIMAL_PLACES)}`);
  if (model) parts.push(model);
  return parts.join(' ');
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(SECONDS_DECIMAL_PLACES)}s`;
  return `${Math.floor(ms / MS_PER_MINUTE)}m${Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND)}s`;
}

/**
 * Format a tool call for display
 */
export function formatToolCall(name: string, args: Record<string, unknown>, expanded = false): string {
  switch (name) {
    case 'bash': {
      const command = typeof args.command === 'string' ? args.command : '';
      const maxLength = expanded ? BASH_PREVIEW_LIMIT_EXPANDED : BASH_PREVIEW_LIMIT;
      return `$ ${command.slice(0, maxLength)}${command.length > maxLength ? TRUNCATION_ELLIPSIS : ''}`;
    }
    case 'read':
    case 'write':
    case 'edit': {
      const target =
        typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : '';
      return `${name} ${shortenPath(target)}`;
    }
    default: {
      const s = JSON.stringify(args);
      const maxLength = expanded ? ARGS_PREVIEW_LIMIT_EXPANDED : ARGS_PREVIEW_LIMIT;
      return `${name} ${s.slice(0, maxLength)}${s.length > maxLength ? TRUNCATION_ELLIPSIS : ''}`;
    }
  }
}

/**
 * Shorten a path by replacing home directory with ~
 */
export function shortenPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) {
    return `${HOME_SHORTHAND}${p.slice(home.length)}`;
  }
  return p;
}
