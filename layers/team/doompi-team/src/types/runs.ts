/**
 * Contracts for the runs domain.
 *
 * These describe the OUTCOME of a run: what was produced, whether it satisfied
 * the conditions set for it, and the evidence behind that judgement. The
 * conditions themselves are declared by an agent and live in the root
 * `src/types.ts`, so the split is intent there, result here.
 *
 * Everything in this file is needed by more than one module in the domain. A
 * type used by exactly one module belongs in that module, not here.
 *
 * DESIGN PATTERNS:
 * - Imports only root contracts, so this module cannot join an import cycle
 * - Types only; no runtime values
 *
 * AVOID:
 * - Adding a type only one module uses
 * - Importing anything from `src/agents/**` or `src/runs/**`
 */

import type {
  AcceptanceEvidenceKind,
  AcceptanceGate,
  AcceptanceLevel,
  AcceptanceReviewGate,
  AcceptanceVerifyCommand,
} from '.';

/**
 * Re-exported from the root contracts.
 *
 * Both live in `src/types.ts` because the intercom domain describes runs it did
 * not launch, and a domain may not import a sibling domain's types. They are
 * re-exported here so the runs domain still reads as their owner.
 */
export type { SubagentResultStatus, SubagentRunMode } from '.';

/** Where a run's output was written when it was too large to return inline. */
export interface SavedOutputReference {
  path: string;
  bytes: number;
  lines: number;
  message: string;
}

/**
 * Marks a payload as speaking the agent contract.
 *
 * Version is pinned rather than open: a child that speaks a version the parent
 * does not know must be rejected, not partially understood.
 */
export interface AgentContract {
  version: 1;
}

// ============================================================================
// Acceptance: resolved conditions
//
// "Resolved" means defaults have been applied and inference has run, so every
// optional field of the declared config has a definite value here. Consumers
// read these and never re-derive them.
// ============================================================================

export interface ResolvedAcceptanceGate extends AcceptanceGate {
  id: string;
  must: string;
  evidence: AcceptanceEvidenceKind[];
  severity: 'required' | 'recommended';
}

export interface ResolvedAcceptanceConfig {
  /** `auto` is resolved away: by this point the level has actually been decided. */
  level: Exclude<AcceptanceLevel, 'auto'>;
  /** True when the author stated the level, false when it was inferred. */
  explicit: boolean;
  inferredReason: string[];
  criteria: ResolvedAcceptanceGate[];
  evidence: AcceptanceEvidenceKind[];
  verify: AcceptanceVerifyCommand[];
  review?: AcceptanceReviewGate | false;
  stopRules: string[];
  reason?: string;
}

// ============================================================================
// Acceptance: evidence and outcome
// ============================================================================

/** What the child claims it did. Unverified by construction; the parent checks it. */
export interface AcceptanceReport {
  criteriaSatisfied?: Array<{
    id?: string;
    status: 'satisfied' | 'not-satisfied' | 'not-applicable';
    evidence: string;
  }>;
  changedFiles?: string[];
  testsAddedOrUpdated?: string[];
  commandsRun?: Array<{
    command: string;
    result: 'passed' | 'failed' | 'not-run';
    summary: string;
  }>;
  validationOutput?: string[];
  residualRisks?: string[];
  noStagedFiles?: boolean;
  diffSummary?: string;
  reviewFindings?: string[];
  manualNotes?: string;
  notes?: string;
}

export type AcceptanceRuntimeCheckStatus = 'passed' | 'failed' | 'not-applicable';

/** A check the runtime performed itself, rather than taking the child's word for. */
export interface AcceptanceRuntimeCheck {
  id: string;
  status: AcceptanceRuntimeCheckStatus;
  message: string;
}

export interface AcceptanceVerifyResult {
  id: string;
  command: string;
  cwd?: string;
  /** Null when the process was killed before it could exit. */
  exitCode: number | null;
  status: 'passed' | 'failed' | 'timed-out' | 'allowed-failure';
  stdout?: string;
  stderr?: string;
  durationMs: number;
}

export interface AcceptanceReviewResult {
  status: 'review-required' | 'reviewed' | 'blockers';
  findings: Array<{
    severity: 'blocker' | 'non-blocking';
    file?: string;
    issue: string;
    rationale: string;
  }>;
}

export type AcceptanceEvidenceStatus =
  | 'pending'
  | 'not-required'
  | 'claimed'
  | 'attested'
  | 'checked'
  | 'verified'
  | 'rejected';

export type AcceptanceLedgerStatus = AcceptanceEvidenceStatus | 'review-required' | 'reviewed' | 'accepted';

/**
 * The full record of how a run was judged.
 *
 * Carries the claim, the checks, and the decision separately and on purpose:
 * `childReport` is asserted by the child, `runtimeChecks` and `verifyRuns` are
 * independently observed, and `parentDecision` is the human or parent ruling.
 * Collapsing them would make an unverified claim indistinguishable from a
 * verified one.
 */
export interface AcceptanceLedger {
  status: AcceptanceLedgerStatus;
  evidenceStatus: AcceptanceEvidenceStatus;
  explicit: boolean;
  effectiveAcceptance: ResolvedAcceptanceConfig;
  inferredReason: string[];
  criteria: ResolvedAcceptanceGate[];
  childReport?: AcceptanceReport;
  /** Set when the child's report could not be parsed; the raw failure is kept. */
  childReportParseError?: string;
  runtimeChecks: AcceptanceRuntimeCheck[];
  verifyRuns: AcceptanceVerifyResult[];
  reviewResult?: AcceptanceReviewResult;
  parentDecision?: {
    status: 'accepted' | 'rejected';
    at: string;
    reason?: string;
  };
}
