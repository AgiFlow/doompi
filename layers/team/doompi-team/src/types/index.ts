/**
 * Shared contracts for the doom-team runtime.
 *
 * DESIGN PATTERNS:
 * - Interface-first: services are injected against `I*` contracts, never classes
 * - Imports nothing from `src/**`, so this module can never join an import cycle
 *
 * AVOID:
 * - Importing service implementations here
 * - Adding runtime values; this file is types only
 */

/** Token counts accumulated over a run or a single step. */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

/** Full accounting for one child, including cache traffic and billed cost. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/**
 * Why a run is being surfaced for the operator's attention.
 *
 * Absent means the run is progressing normally, so this is deliberately not a
 * three-state union with an `ok` member.
 */
export type ActivityState =
  | 'starting'
  | 'working'
  | 'tool'
  | 'waiting_for_reply'
  | 'needs_attention'
  | 'finalizing'
  | 'active_long_running';

/**
 * Lifecycle of a single step within a run.
 *
 * `complete` and `completed` both mean finished. Both spellings exist in status
 * files already written to disk, so readers must accept either.
 */
export type StepStatus = 'pending' | 'running' | 'complete' | 'completed' | 'failed' | 'paused' | 'stopped';

// ============================================================================
// Chain steps
// ============================================================================
// Chain steps come from user-authored frontmatter and carry no discriminator, so
// the union is told apart by shape. Only the fields consumers currently read are
// declared; later ports widen these rather than redeclaring them elsewhere.

// ============================================================================
// Artifacts
// ============================================================================

/** Every file a single child run writes. Derived from the run id, never stored. */
export interface ArtifactPaths {
  inputPath: string;
  outputPath: string;
  jsonlPath: string;
  transcriptPath: string;
  metadataPath: string;
}

/**
 * Where artifacts are written.
 *
 * `project` keeps them beside the code under review, `session` ties them to the
 * host agent session, and `temp` leaves nothing in the working tree.
 */
export type ArtifactDirPreference = 'project' | 'session' | 'temp';

/**
 * Reported when a child emits a single line larger than the reader will buffer.
 *
 * A child that never emits a newline would otherwise grow the buffer until the
 * parent runs out of memory, so the reader stops and reports instead. The
 * prefix and tail are bounded samples for diagnosing what the child was writing.
 */
export interface ProtocolOutputLimit {
  code: 'protocol_output_limit';
  stream: 'stdout' | 'stderr';
  limitBytes: number;
  observedBytes: number;
  diagnosticPrefix: string;
  diagnosticTail: string;
}

// ============================================================================
// Run shaping
//
// Declared by an agent's frontmatter or by settings, and enforced by the runs
// domain. They live here rather than in either domain because both sides need
// them and neither owns the other.
// ============================================================================

/** Whether an agent's prompt extends the host's system prompt or replaces it. */
export type SystemPromptMode = 'append' | 'replace';

/** Whether a run's output is returned inline or only written to its file. */
export type OutputMode = 'inline' | 'file-only';

/** Caps on how much output a run may return inline. */
export interface MaxOutputConfig {
  bytes?: number;
  lines?: number;
}

/** A JSON Schema object, carried opaquely; it is validated by the host, not here. */
export type JsonSchemaObject = Record<string, unknown>;

/**
 * How a run was launched.
 *
 * A root contract rather than a runs-domain type: the intercom channels
 * describe and route runs they did not launch, and a domain may not reach into
 * a sibling domain for a vocabulary both of them speak.
 */
export type SubagentRunMode = 'single' | 'parallel' | 'chain';

/** How a run ended. Shared with intercom for the same reason as `SubagentRunMode`. */
export type SubagentResultStatus = 'completed' | 'failed' | 'paused' | 'stopped' | 'detached';

/**
 * A ceiling on how many turns a child may take.
 *
 * `graceTurns` is what separates a wrap-up request from a hard stop: the child
 * is asked to conclude at `maxTurns` and only terminated after the grace turns
 * are also spent, so a run that is nearly done still gets to report.
 */
export interface TurnBudgetConfig {
  maxTurns: number;
  graceTurns?: number;
}

/**
 * A ceiling on how many tool calls a child may make.
 *
 * `soft` nudges, `hard` blocks. `block` narrows enforcement to named tools, or
 * `'*'` for all of them.
 */
export interface ToolBudgetConfig {
  soft?: number;
  hard: number;
  block?: string[] | '*';
}

/**
 * Which models an agent is permitted to run on.
 *
 * Patterns are glob-style with only `*` special, matched against `provider/id`.
 * Enforcement severity depends on where the model came from: an explicitly
 * requested out-of-scope model is an error, an inherited one is a warning.
 */
export interface ModelScopeConfig {
  enforce?: boolean;
  allow?: string[];
}

// ============================================================================
// Acceptance
// ============================================================================

export type AcceptanceLevel = 'auto' | 'none' | 'attested' | 'checked' | 'verified';

/** Whether an accepting agent may modify the tree or only inspect it. */
export type AcceptanceRole = 'read-only' | 'writer';

export type AcceptanceEvidenceKind =
  | 'changed-files'
  | 'tests-added'
  | 'commands-run'
  | 'validation-output'
  | 'residual-risks'
  | 'no-staged-files'
  | 'diff-summary'
  | 'review-findings'
  | 'manual-notes';

/** One condition a run must satisfy before it can be accepted. */
export interface AcceptanceGate {
  id: string;
  must: string;
  evidence?: AcceptanceEvidenceKind[];
  severity?: 'required' | 'recommended';
}

/** A command whose exit status is evidence for acceptance. */
export interface AcceptanceVerifyCommand {
  id: string;
  command: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  allowFailure?: boolean;
}

export interface AcceptanceReviewGate {
  agent?: string;
  focus?: string;
  required?: boolean;
}

export interface AcceptanceConfig {
  level?: AcceptanceLevel;
  criteria?: Array<string | AcceptanceGate>;
  evidence?: AcceptanceEvidenceKind[];
  verify?: AcceptanceVerifyCommand[];
  review?: AcceptanceReviewGate | false;
  stopRules?: string[];
  reason?: string;
}

/**
 * Acceptance as an agent may declare it.
 *
 * A bare `'none'` is deliberately not accepted: opting out has to be stated as
 * `{ level: 'none', reason: '...' }` so the reason is recorded. `false` remains
 * a deprecated shorthand for the same thing.
 */
export type AcceptanceInput = Exclude<AcceptanceLevel, 'none'> | false | AcceptanceConfig;
