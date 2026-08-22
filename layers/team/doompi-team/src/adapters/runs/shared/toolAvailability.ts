/**
 * Diagnostics for child tools an agent asked for that the child never registered.
 *
 * The `tools` field on an agent is a strict allowlist: it selects from what the
 * child process already has, it does not cause extension code to load. When the
 * two disagree the child notices, not the parent, and the child's stderr is not
 * where a user looks. So the child drops a small file the parent reads after the
 * run and turns into an actionable message.
 *
 * DESIGN PATTERNS:
 * - The file is a negative signal only. A run with nothing missing removes it,
 *   so a stale file from an earlier run can never be reported against a later one
 * - Written 0600 and atomically, because it is parsed by a different process and
 *   a torn read is indistinguishable from a corrupt file
 * - Reads validate every field. The file is JSON on disk that any process could
 *   have written, so nothing is trusted on shape alone
 *
 * AVOID:
 * - Treating a malformed diagnostic as "nothing missing"; it is reported as a
 *   read failure instead, because a silent empty result hides the tool gap
 */

import * as fs from 'node:fs';
import { writePrivateAtomicJson } from '../../atomicJson';

export interface ChildToolDiagnostic {
  agent?: string;
  required: string[];
  available: string[];
  missing: string[];
  missingMcpDirectTools?: string[];
}

/**
 * Tools every child has regardless of what it reported.
 *
 * The child registry snapshot can be taken before the builtins finish
 * registering, so treating these as always available avoids a false alarm.
 */
const CORE_CHILD_TOOLS = new Set(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

/**
 * Record the gap between requested and registered tools, or clear a stale record.
 *
 * Returns the diagnostic when there is one so the caller can report it without
 * reading back what it just wrote.
 */
export function writeChildToolDiagnostic(
  filePath: string,
  required: string[],
  available: string[],
  agent?: string,
  mcpDirectTools?: string[],
): ChildToolDiagnostic | undefined {
  const availableNames = new Set([...available, ...CORE_CHILD_TOOLS]);
  const missing = required.filter((name) => !availableNames.has(name));
  if (missing.length === 0) {
    fs.rmSync(filePath, { force: true });
    return undefined;
  }

  const missingMcpDirectTools = mcpDirectTools?.length ? missing.filter((name) => mcpDirectTools.includes(name)) : [];
  const diagnostic: ChildToolDiagnostic = {
    ...(agent !== undefined ? { agent } : {}),
    required,
    available,
    missing,
    ...(missingMcpDirectTools.length > 0 ? { missingMcpDirectTools } : {}),
  };
  writePrivateAtomicJson(filePath, diagnostic);
  return diagnostic;
}

/** Read a diagnostic written by a child. Throws when the file exists but is not one. */
export function readChildToolDiagnostic(filePath: string | undefined): ChildToolDiagnostic | undefined {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (
    !isRecord(parsed) ||
    !isNonEmptyStringArray(parsed.required) ||
    !isNonEmptyStringArray(parsed.available) ||
    !isNonEmptyStringArray(parsed.missing) ||
    (parsed.agent !== undefined && typeof parsed.agent !== 'string') ||
    (parsed.missingMcpDirectTools !== undefined && !isNonEmptyStringArray(parsed.missingMcpDirectTools))
  ) {
    throw new Error(`Malformed child tool diagnostic at '${filePath}'.`);
  }
  return {
    ...(parsed.agent ? { agent: parsed.agent } : {}),
    required: parsed.required,
    available: parsed.available,
    missing: parsed.missing,
    ...(parsed.missingMcpDirectTools ? { missingMcpDirectTools: parsed.missingMcpDirectTools } : {}),
  };
}

export function formatChildToolDiagnostic(diagnostic: ChildToolDiagnostic): string {
  const subject = diagnostic.agent ? `Agent '${diagnostic.agent}'` : 'Subagent';
  return [
    `${subject} requested unavailable child tools: ${diagnostic.missing.join(', ')}.`,
    'The `tools` field is a strict allowlist; it does not load extension code.',
    ...(diagnostic.missingMcpDirectTools?.length
      ? [
          `Resolved MCP direct tools missing from the child registry: ${diagnostic.missingMcpDirectTools.join(', ')}. This indicates a doom-mcp registration problem, not a tool-call failure.`,
        ]
      : []),
    'For extension tools, add the provider path to `subagentOnlyExtensions` (child-only), `extensions`, or as a path-like entry in `tools`, while keeping each registered tool name in `tools`.',
    'For MCP tools, check `/mcp` in the parent session for the server state, and verify the selected tool names. For builtin tools, verify the name against the installed Pi version.',
  ].join('\n');
}

/**
 * The reportable message for a run, or undefined when nothing was missing.
 *
 * A read failure is surfaced as its own message rather than swallowed: the file
 * existing at all means the child had a tool gap, so returning undefined here
 * would report a broken run as a clean one.
 */
export function readChildToolDiagnosticError(filePath: string | undefined): string | undefined {
  try {
    const diagnostic = readChildToolDiagnostic(filePath);
    return diagnostic ? formatChildToolDiagnostic(diagnostic) : undefined;
  } catch (error) {
    return `Failed to read child tool availability diagnostic: ${error instanceof Error ? error.message : String(error)}`;
  }
}
