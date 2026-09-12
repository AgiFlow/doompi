/**
 * The ancestry chain a nested child inherits from its parent.
 *
 * Each entry names one run in the line from the root run down to the child's
 * immediate parent, so a grandchild can report where it sits without the root
 * having to be asked.
 *
 * DESIGN PATTERNS:
 * - Sanitize on both encode and decode. The value crosses a process boundary in
 *   an environment variable, so it is untrusted in both directions: a child
 *   reads whatever its parent set, and a parent may be encoding ids that came
 *   from further up. Neither side is a trusted source
 * - Every id is checked to be usable as a single path segment. Run ids become
 *   directory names for run state, so a separator or `..` in one is a traversal,
 *   not a formatting problem
 * - Malformed input degrades to an empty path rather than throwing. A broken
 *   ancestry record is reporting metadata; it must not fail the run carrying it
 * - The chain is length-capped, so a fan-out loop cannot grow the variable until
 *   it exceeds the environment block limit and breaks every later spawn
 *
 * AVOID:
 * - Trusting a decoded entry without re-sanitizing it
 * - Using an entry's `runId` in a path without this module having produced it
 */

import * as path from 'node:path';

const MAX_NESTED_ID_LENGTH = 128;
const MAX_AGENT_NAME_LENGTH = 128;
const PARENT_DIRECTORY_SEGMENT = '..';
export const MAX_NESTED_PATH_ENTRIES = 4;

export type NestedPathEntry = { runId: string; stepIndex?: number; agent?: string };

/** True when `value` is safe to use as a single path segment. */
export function isSafeNestedPathId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_NESTED_ID_LENGTH &&
    !path.isAbsolute(value) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes(PARENT_DIRECTORY_SEGMENT)
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

/**
 * Keep only the entries that are well formed, dropping the rest.
 *
 * An entry without a safe `runId` is discarded entirely rather than repaired:
 * there is nothing to fall back to, and a guessed id would name the wrong run.
 * `stepIndex` and `agent` are labels only, so an unusable one is simply omitted.
 */
export function sanitizeNestedPath(value: unknown): NestedPathEntry[] {
  if (!Array.isArray(value)) return [];
  const sanitized: NestedPathEntry[] = [];
  for (const part of value) {
    if (typeof part !== 'object' || part === null) continue;
    const record: Record<string, unknown> = part as Record<string, unknown>;
    const runId = record.runId;
    if (!isSafeNestedPathId(runId)) continue;
    const stepIndex = finiteNumber(record.stepIndex);
    const agent = nonEmptyString(record.agent, MAX_AGENT_NAME_LENGTH);
    sanitized.push({
      runId,
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      ...(agent ? { agent } : {}),
    });
    if (sanitized.length === MAX_NESTED_PATH_ENTRIES) break;
  }
  return sanitized;
}

export function parseNestedPathEnv(value: string | undefined): NestedPathEntry[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return sanitizeNestedPath(parsed);
  } catch {
    // The variable was set by another process and may be anything. An
    // unparseable ancestry reads as no ancestry, which is the narrow outcome.
    return [];
  }
}

/** Empty string, not `[]`, so an absent path and an empty one look alike to a child. */
export function encodeNestedPathEnv(value: NestedPathEntry[]): string {
  const sanitized = sanitizeNestedPath(value);
  return sanitized.length ? JSON.stringify(sanitized) : '';
}
