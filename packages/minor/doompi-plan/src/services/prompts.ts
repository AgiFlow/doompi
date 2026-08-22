export type PlanningFlavor = 'normal' | 'debug' | 'fable';

export interface DebugEvidencePacket {
  issue: string;
  expectedBehavior: string;
  reproductionAttempt: string;
  actualBehavior: string;
  logs: string[];
  correlatedTraceEvidence: string[];
  processOutput: string[];
  browserConsoleEvidence: string[];
  correlationIds: string[];
  timestamps: string[];
  verifiedFacts: string[];
  hypotheses: string[];
  unavailableEvidence: string[];
}

const EVIDENCE_FIELDS: readonly (keyof DebugEvidencePacket)[] = [
  'issue',
  'expectedBehavior',
  'reproductionAttempt',
  'actualBehavior',
  'logs',
  'correlatedTraceEvidence',
  'processOutput',
  'browserConsoleEvidence',
  'correlationIds',
  'timestamps',
  'verifiedFacts',
  'hypotheses',
  'unavailableEvidence',
];

function evidenceLines(packet: DebugEvidencePacket): string {
  return EVIDENCE_FIELDS.flatMap((field) => {
    const value = packet[field];
    if (Array.isArray(value) && value.length === 0) return [];
    if (typeof value === 'string' && value.length === 0) return [];
    return `${field}: ${Array.isArray(value) ? value.join(' | ') : value}`;
  }).join('\n');
}

export function buildNormalPlanningPrompt(plansDirectory: string): string {
  return `[PLAN MODE ACTIVE: NORMAL]\nYou are in repository read-only normal planning. The dedicated write_plan tool may write one unique Markdown plan file under ${plansDirectory}.\n\nExplore the codebase and produce a concrete implementation plan. For every plan, first call subagent with action "agents", cluster exploration by independent domain, subsystem, or integration boundary, and create a provisional task graph with the task tool. Select specialized agents by matching their names and descriptions to each cluster. Assign every unblocked delegated task through the task tool, and use a one-shot inlineAgent with a focused systemPrompt when no discovered specialist fits. Treat the initial graph as provisional, not as a fixed contract. After findings arrive, review the entire graph at least once and perform one to three review passes in total. In each pass, use evidence to add, rewrite, delete, cancel, reassign, or change blockedBy relationships for tasks when warranted. Do not keep following tasks that new information has made stale. Stop revising early when the graph is stable, or after the third pass.\n\nEvery plan must end with a delegated planning-draft stage blocked by all exploration and decision tasks. A single-boundary plan gets one planning draft. A complex plan spanning multiple subsystems, domains, packages, apps, or integration boundaries gets two planning drafts concurrently. Use three concurrent drafts instead when the work is cross-layer, migration-sensitive, security-sensitive, or similarly high risk. Assign each draft through the task tool to the discovered planner agent with context "fork" so it receives the conversation and gathered evidence. If the planner agent is unavailable, assign the same draft task through the task tool with a focused inlineAgent. All children receive read, Bash, grep, find, ls, and configured MCP tools with artifacts disabled. Bash and MCP tools are for read-only inspection and must not modify files, external systems, or repository state. Doom Team runs asynchronously, so do not poll. After launch, continue non-overlapping exploration or end your turn; completion notifications wake the parent session.\n\nAfter all planning drafts complete, compare the candidates, pick the strongest draft, cross-check it against gathered evidence and the other drafts, resolve conflicts and gaps, and ask the user only for product decisions. A child produces the draft, but the main agent owns and synthesizes the final plan. Do not modify files or repository state except through write_plan. Start the final plan with a meaningful Markdown H1 because write_plan derives the filename from it. Present the complete plan as visible Markdown, then call write_plan with no arguments. After write_plan succeeds, clear the completed durable task graph and call complete_plan so the user can review the plan and choose whether to begin implementation or continue planning. Do not exit plan mode without that approval.`;
}

export function buildDebugPlanningPrompt(plansDirectory: string, evidence: DebugEvidencePacket | undefined): string {
  const guidance = evidence
    ? `A bounded debug evidence packet is recorded below. Cite its verified facts when making source findings. Keep verified facts and hypotheses distinct. Do not claim a verified root cause when reproduction or supporting evidence is unavailable.\n\n[DEBUG EVIDENCE]\n${evidenceLines(evidence)}`
    : 'No structured debug evidence packet is recorded yet. First understand the reported issue, then gather only the evidence relevant to it. Recording evidence is optional and must not block source exploration, delegation, writing a plan, or completing a plan.';
  return `[PLAN MODE ACTIVE: DEBUG]\nYou are in repository read-only adaptive debug planning. The dedicated write_plan tool may write one unique Markdown plan file under ${plansDirectory}.\n\n${guidance}\n\nUse the exact read-only tools available for the issue. Bash is available for repository inspection, but commands must not modify files or repository state. Treat unavailable evidence as unavailable, never invent its contents, and keep verified facts separate from hypotheses. ${evidence ? 'The final plan must separate verified facts from hypotheses and must not present an unsupported root cause as verified.' : 'You may call record_debug_evidence when structured notes would help, but continue investigating without it when it is not relevant.'}`;
}

export function buildFablePlanningPrompt(plansDirectory: string, stage: string): string {
  return `[PLAN MODE ACTIVE: FABLE]\nYou are in repository read-only Fable planning. Pi owns final verification and synthesis. The dedicated write_plan tool may write one unique Markdown plan file under ${plansDirectory}.\n\nUse Pi read-only exploration first. When the bounded packet is ready, call run_fable_plan. Fable runs one fresh draft with repository inspection access and returns untrusted text. Cross-check every Fable claim against repository evidence, keep verified findings separate from explicitly inferred findings, resolve conflicts yourself, and present the final visible plan before calling write_plan. Never treat Fable output as repository evidence and never expose credentials, transcripts, commands, tools, or session data in the packet.\n\nCurrent Fable stage: ${stage}. An interrupted stage is not relaunched automatically.`;
}

export function buildFlavorPlanningPrompt(
  flavor: PlanningFlavor,
  plansDirectory: string,
  evidence: DebugEvidencePacket | undefined,
  fableStage: string,
): string {
  if (flavor === 'debug') return buildDebugPlanningPrompt(plansDirectory, evidence);
  if (flavor === 'fable') return buildFablePlanningPrompt(plansDirectory, fableStage);
  return buildNormalPlanningPrompt(plansDirectory);
}
