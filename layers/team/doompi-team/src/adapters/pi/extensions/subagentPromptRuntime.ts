/**
 * The extension loaded INSIDE every spawned child: prompt rewriting,
 * mid-run steering delivery, the tool-call budget, native supervisor/team
 * messaging, and the `structured_output` tool.
 *
 * WHY THIS RUNS IN A DIFFERENT WORLD THAN EVERYTHING ELSE PORTED SO FAR:
 * Every other module in this package runs in the parent or the runner
 * process. This one is loaded BY the child's own Pi process
 * (`piArgs.ts`'s `resolveRuntimeExtensionPath` resolves it onto the
 * child's `--extension` args). The child's stdout IS its captured
 * transcript - a stray console write here does not go to a developer's
 * terminal, it becomes part of the child's output. Nothing in this file
 * writes to the console, ever; a failure that would have been
 * logged elsewhere is swallowed with a comment when there is no safe channel
 * to report it.
 *
 * FIX (claim-by-rename for the per-child steer inbox):
 * The predecessor's `registerSteeringInbox` called
 * `consumeSteerRequestsFromDir`, which deletes every queued request before
 * attempting delivery, then manually re-queued whatever it had not yet
 * attempted (`requests.slice(index + 1)`) if `sendUserMessage` threw
 * partway through a batch - but the request that was actually attempted
 * when the throw happened was already gone, lost the same way FIX 1 in
 * `control-channel.ts` was written to close for the runner-side steer
 * queue. This module's `flush()` uses `claimSteerRequestsFromDir` (already
 * exported from `control-channel.ts`, directory-agnostic) instead: each
 * request is claimed individually, and a failed `sendUserMessage` call
 * calls `release()` on that one claim so it is retried on the next flush,
 * while every OTHER claim in the same batch is still committed or released
 * independently. That is also a behavioural improvement over the
 * predecessor's `break`-on-first-failure, which abandoned the rest of a
 * batch rather than giving each message its own outcome - the same
 * per-item independence `ControlChannelWatcher.check()` already applies on
 * the runner side.
 *
 * Child runtimes keep the native team transport for lifecycle and result
 * delivery, but model-visible coordination tools are filtered by Team package
 * policy. They never register the root orchestration tool or a separate wait
 * alias.
 *
 * AVOID:
 * - Writing to the console. See the header above
 * - Reintroducing the predecessor's "delete the whole batch, dispatch,
 *   re-queue what failed" shape for the steer inbox. See the FIX above
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
  decodeProtectedParentProcessIds,
  INHERIT_PROJECT_CONTEXT_ENV,
  INHERIT_SKILLS_ENV,
  MCP_DIRECT_CHILD_TOOLS_ENV,
  REQUIRED_CHILD_TOOLS_ENV,
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_FANOUT_CHILD_ENV,
  SUBAGENT_INTERCOM_SESSION_NAME_ENV,
  SUBAGENT_PROTECTED_PARENT_PIDS_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_STEER_ACK_DIR_ENV,
  SUBAGENT_STEER_CAPABILITY_ENV,
  SUBAGENT_STEER_INBOX_ENV,
  TOOL_BUDGET_ENV,
  TOOL_BUDGET_ZERO_AUTH_ENV,
} from '../../../types/environment';
import { createTeamPromptRuntime } from '../promptRuntime';
import {
  NATIVE_TEAM_TOOL_NAME,
  nativeTeamMemberEnvironment,
  type TeamMemberContext,
} from '../../intercom/nativeTeamChannel';
import {
  claimSteerRequestsFromDir,
  type SteerRequest,
  steerAckPathFromDir,
  writeSteerAckAt,
  writeSteerCapabilityAt,
} from '../../intercom/supervisorControlChannel';
import type { RunnerBootstrapContract } from '../../runs/background/runnerBootstrap';
import type { RunnerExecutionContract } from '../../runs/background/runnerExecution';
import type { RunnerReportingContract } from '../../runs/background/runnerReporting';
import { createStructuredOutputToolParameters, StructuredOutputValidator } from '../../runs/shared/structuredOutput';
import { type ChildToolDiagnostic, writeChildToolDiagnostic } from '../../runs/shared/toolAvailability';
import type { ResolvedToolBudget } from '../../runs/shared/toolBudget';
import {
  decodeToolBudgetEnv,
  shouldBlockToolForBudget,
  toolBudgetBlockedMessage,
  toolBudgetSoftNudge,
} from '../../runs/shared/toolBudget';
import {
  type ChildTranscriptMessage,
  formatToolActivity,
  getMessageActivity,
  getMessageUsageTokens,
} from '../../process/childTranscript';
import { resolveWatchPath } from '../../filesystem/configDir';
import { adoptSessionScopeFromEnv } from '../../filesystem/paths';
import type { PollSchedulerContract } from '../../pollScheduler';
import type { JsonSchemaObject } from '../../../types';

const STEER_FLUSH_POLL_INTERVAL_MS = 250;
const PROCESS_SIGNAL_COMMAND_PATTERN = /\bkill(?:pg)?\b/i;
const BROAD_PROCESS_TERMINATION_PATTERN = /(?:^|[^\w.-])(?:pkill|killall|shutdown|reboot|poweroff|halt)(?=$|[^\w.-])/i;
const WORKFLOW_TERMINAL_TERMINATION_PATTERN = /\b(?:tmux|cmux)\b[\s\S]*\b(?:kill-server|kill-session|close|quit)\b/i;
const PARENT_PID_REFERENCE_PATTERN = /\$(?:PPID|\{PPID\})|\bprocess\.ppid\b|\bgetppid\s*\(|\bppid\b/i;
const DYNAMIC_PROCESS_TARGET_PATTERN = /\$\(|`|\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)/;
const ALL_PROCESSES_KILL_TARGET_PATTERN = /(?:^|[\s"'`])-1(?=$|[\s"'`;|&])/;
const PARENT_PROCESS_BLOCK_REASON =
  'Blocked: subagents may use Bash, but cannot signal parent or workflow processes. Ask the parent to perform that process cleanup.';
const PROMPT_RUNTIME_SOURCE = '@agimon-ai/doompi-team/prompt-runtime';

/**
 * Failures this runtime absorbed rather than propagated.
 *
 * WHY RECORD RATHER THAN LOG:
 * This module runs inside the spawned child, where stdout IS the child's
 * captured transcript. Writing a diagnostic there would corrupt the very
 * output the run exists to produce, so nothing here may reach stdio. But a
 * discarded error is indistinguishable from one that never happened, and a
 * watcher that fails on every event looks exactly like a quiet inbox. These
 * counters are the compromise: cheap, bounded, and queryable by a caller that
 * wants to know whether the child's steering path was actually healthy.
 *
 * WHY THIS IS CALLER-OWNED, NOT MODULE STATE:
 * A module-level singleton here would be exactly the bug this package's "no
 * module-level mutable state" rule exists to prevent - see
 * `nativeTeamChannel.ts`'s header: "a second session in the same process
 * cannot inherit the first one's [state]". `registerSubagentPromptRuntime`
 * runs once per real child process, so a singleton would rarely matter in
 * production, but every test in this file registers multiple independent
 * runtimes in one process, and a shared singleton would leak counts between
 * them silently. `createPromptRuntimeDiagnostics()` hands each registration
 * its own object instead; the caller keeps the reference to read later, and
 * a fresh registration is what "reset" means - there is no shared state left
 * to reset.
 *
 * AVOID:
 * - Adding a `console.*` here, on any path, for any reason
 * - Treating a non-zero count as fatal; every one of these is a degraded-mode
 *   path with a working fallback, which is why it was absorbed in the first place
 * - Reintroducing a module-level instance of this. See the header above
 */
export interface PromptRuntimeDiagnostics {
  /** Advisory tool-budget nudges that could not be delivered to the child. */
  steerNudgeFailures: number;
  /** Errors emitted by the steer-inbox watcher. The interval poll covers these. */
  watchErrors: number;
  /** Failures closing the watcher during shutdown. */
  watchCloseFailures: number;
  /** The most recent absorbed failure, whichever kind it was. */
  lastError?: unknown;
}

/** A fresh, zeroed diagnostics object for one registration. See the interface doc for why this is not a singleton. */
export function createPromptRuntimeDiagnostics(): PromptRuntimeDiagnostics {
  return { steerNudgeFailures: 0, watchErrors: 0, watchCloseFailures: 0 };
}

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
  'This subagent step has a strict structured output contract.',
  'Your final action must be to call the `structured_output` tool with JSON matching the provided schema.',
  'Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.',
].join('\n');

export const CHILD_CONTEXT_FIRST_INSTRUCTIONS = [
  'When the assigned task includes a parent context pack, treat it as the authoritative starting point.',
  'That pack satisfies generic instructions to explore or understand repository context first.',
  'Read its listed paths directly before broad discovery, and do not re-derive established facts unless direct evidence contradicts them.',
  'Do not begin with repository-wide listing, find, or grep. Expand only after consuming the pack and naming a concrete missing dependency or invalid path; search narrowly for that item and state why.',
].join('\n');

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
  'You are a child subagent, not the parent orchestrator.',
  'The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.',
  'Ignore prior parent-only orchestration instructions in inherited conversation history.',
  'Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.',
  'If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.',
  CHILD_CONTEXT_FIRST_INSTRUCTIONS,
].join('\n');

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
  'You are a child subagent with explicit fanout responsibility for this assigned task.',
  'The parent session owns final orchestration, acceptance, and follow-up implementation launches.',
  'You may use the `subagent` tool only for the fanout work explicitly requested in this task.',
  'Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.',
  'The maxSubagentDepth cap still applies and may block further fanout.',
  'If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.',
  CHILD_CONTEXT_FIRST_INSTRUCTIONS,
].join('\n');

/**
 * `pi.on` typed loosely: the extension API's event payloads are not typed
 * per event name, so every call site narrows its own handler's parameter.
 * `.call(pi, ...)` binds `this` explicitly rather than extracting `pi.on` as
 * a bare reference, which is what an unbound method call would otherwise risk.
 *
 * The handler is given `ctx: ExtensionContext` as a second parameter,
 * matching the real `pi.on` signature (`ExtensionHandler<E, R> = (event: E,
 * ctx: ExtensionContext) => ...`) even though most registrations here never
 * read it - existing single-parameter handlers stay valid without change
 * (JS ignores a callback's unused trailing parameters), and the one call
 * site that DOES need it (`session_start`, for `ctx.sessionManager` - see
 * `registerDeliverableGuardCheck`'s doc) no longer has to reach past this
 * wrapper to get it.
 */
function onEvent<E = unknown>(
  pi: ExtensionAPI,
  event: string,
  handler: (event: E, ctx: ExtensionContext) => unknown,
): void {
  (pi.on as unknown as (event: string, handler: (event: E, ctx: ExtensionContext) => unknown) => void).call(
    pi,
    event,
    handler,
  );
}

function commandMentionsProcessId(command: string, pid: number): boolean {
  return new RegExp(`(?:^|\\D)-?${pid}(?!\\d)`).test(command);
}

/**
 * Return the blocking reason only when Bash could reach workflow-owned
 * processes. Literal signals to another PID remain available for child-owned
 * cleanup; name-wide selectors and dynamic parent lookup fail closed because
 * their target set cannot be proven not to include the parent.
 */
export function parentProcessTerminationBlockReason(
  command: string,
  protectedProcessIds: readonly number[],
): string | undefined {
  if (BROAD_PROCESS_TERMINATION_PATTERN.test(command) || WORKFLOW_TERMINAL_TERMINATION_PATTERN.test(command)) {
    return PARENT_PROCESS_BLOCK_REASON;
  }
  if (!PROCESS_SIGNAL_COMMAND_PATTERN.test(command)) return undefined;
  if (
    PARENT_PID_REFERENCE_PATTERN.test(command) ||
    DYNAMIC_PROCESS_TARGET_PATTERN.test(command) ||
    ALL_PROCESSES_KILL_TARGET_PATTERN.test(command) ||
    /\bxargs\s+(?:[^;&|\n]+\s+)?kill(?:pg)?\b/i.test(command)
  ) {
    return PARENT_PROCESS_BLOCK_REASON;
  }
  return protectedProcessIds.some((pid) => commandMentionsProcessId(command, pid))
    ? PARENT_PROCESS_BLOCK_REASON
    : undefined;
}

export function registerParentProcessGuard(
  pi: ExtensionAPI,
  options: { protectedProcessIds?: readonly number[] } = {},
): void {
  const protectedProcessIds = [
    ...new Set(
      options.protectedProcessIds ?? [
        ...decodeProtectedParentProcessIds(process.env[SUBAGENT_PROTECTED_PARENT_PIDS_ENV]),
        process.pid,
        process.ppid,
      ],
    ),
  ].filter((pid) => Number.isSafeInteger(pid) && pid > 1);

  onEvent<{ toolName?: unknown; input?: unknown }>(pi, 'tool_call', (event) => {
    if (event.toolName !== 'bash' || !event.input || typeof event.input !== 'object') return undefined;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== 'string') return undefined;
    const reason = parentProcessTerminationBlockReason(command, protectedProcessIds);
    return reason ? { block: true, reason } : undefined;
  });
}

/** A text block from an assistant message's content array. Narrowed structurally, not imported from `@earendil-works/pi-ai`, matching this file's habit of ad-hoc event-payload types (see `onEvent`'s own doc). */
interface AssistantTextBlock {
  type: 'text';
  text: string;
}

/** The subset of `AgentEndEvent`/message shape this file actually reads. */
interface DeliverableCheckMessage {
  role?: string;
  content?: unknown;
}

function isAssistantTextBlock(block: unknown): block is AssistantTextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

/**
 * The last non-empty assistant text found in `messages`, or `''`.
 *
 * `DeliverableGuardInput.summary` is checked for the `'summary'`-kind
 * expectation, and nothing in this package tracks a run's summary text
 * per-turn - `RunnerReporting` only computes one at the terminal
 * `mutateTerminalStatus` callback, which has not happened yet when a
 * mid-run deliverable check needs to run. The assistant's own most recent
 * text output is the best available proxy for "what would this run's
 * summary be if it stopped now" without a dedicated tracking mechanism this
 * package does not have yet. Best-effort by construction: an unparseable or
 * missing message reads as an empty summary, which is the SAFE failure
 * direction for this guard (nudging once more than strictly necessary,
 * never fewer times than necessary).
 */
export function extractAssistantSummaryText(messages: readonly DeliverableCheckMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter(isAssistantTextBlock)
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

/**
 * Wires `DeliverableGuard`'s write side into this process. See the module
 * doc's overall framing: everything else in the missing-deliverable chain
 * (detection, the single nudge, escalation, the fold into `status.json`,
 * `AsyncJobTracker`'s read, and internal completion monitoring) already exist;
 * nothing called them. This is that call.
 *
 * WHY THIS ACCEPTS AN EXPLICIT RUNTIME:
 * The spawned Pi child has a deliberately narrow object graph built by
 * `createTeamPromptRuntime()`. Accepting that typed graph here keeps the
 * production composition in one place while allowing tests to supply the four
 * lifecycle collaborators without starting filesystem-backed services.
 *
 * WHY `session_start` BOOTSTRAPS, AND WHY IT ONLY EVER RUNS ONCE:
 * `RunnerBootstrap.bootstrap()` is genuinely the FIRST real caller this
 * package has ever had for it - it opens `status.json`, wires
 * `TerminalPersistenceService`'s finalize callback, and writes the startup
 * handshake `SpawnHandshake.waitForHandshake()` on the parent side blocks
 * on. `RunnerExecution.start()` then begins watching the control inbox.
 * `ControlChannelWatcher` depends on `PollScheduler`
 * (`control-channel.ts:809`), which nothing in this package's runner
 * services ever calls `.start()` on by itself (see `pollScheduler.ts`'s own
 * AVOID note: "a registered-but-unstarted PollScheduler never ticks") - so
 * this starts it explicitly, once, alongside bootstrap. The `resolved` guard
 * makes a stray second `session_start` (nothing in this file's other
 * registrations assumes it fires only once) a no-op rather than a second
 * bootstrap of the same run.
 *
 * WHY `execution.start()` IS GIVEN AN `onSteer` HANDLER:
 * `DeliverableGuard.deliverNudge()` drops a nudge into this run's OWN
 * steer-requests queue via `requestAsyncSteer` (see that method's doc) and
 * calls it delivered once the write succeeds. But the write alone does not
 * reach the child: `ControlChannelWatcher`, wired up by `execution.start()`,
 * claims and commits (deletes) every request it finds in that queue whether
 * or not a handler is registered for it - found by testing this file
 * against the REAL `ControlChannelWatcher` rather than a fake with no side
 * effects, which is exactly the failure mode this task kept turning up
 * elsewhere (`createRunsModule()` never loaded into any root;
 * `PollScheduler.start()` never called). `onSteer` is the missing delivery
 * half: it reuses `formatSteerMessage`/`sendUserMessage`, the same
 * mechanism `registerSteeringInbox` already uses for its own, separate
 * steer queue, so a nudge actually lands in the child's conversation instead
 * of being silently claimed and discarded.
 *
 * WHY `agent_end`, NOT `turn_end`:
 * `agent_end`'s own event (`AgentEndEvent.messages`) carries the full
 * message history for this agent loop, which `extractAssistantSummaryText`
 * reads from - `turn_end` only carries the one message that ended that turn,
 * not the memory of what preceded it, and `DeliverableGuard`'s own doc
 * frames this check as "end-of-turn or idle", not "every turn."
 *
 * `unansweredAsks` AND `memberId`:
 * Both come from this run's own bound `TeamMemberContext`, which
 * `RunnerBootstrap.bootstrap()` already holds (from registering as a team
 * member) and now returns on its result. `memberId` is `teamContext.memberId`
 * directly. `unansweredAsks` calls `pendingAsksAddressedTo(teamContext,
 * teamContext.memberId, now)` - see `deliverable-guard.ts`'s own AVOID
 * section for why `DeliverableGuard` cannot call that itself, and that
 * function's own doc for why it deliberately returns id/sender/time only,
 * never the question's text (this maps its result into a factual, non-
 * fabricated placeholder message rather than guessing at content it was
 * never given). A standalone run with no team root forwarded has no
 * `teamContext` at all, in which case both are simply omitted - narrower
 * than the real behaviour, never wider, matching every other gap in this
 * file when there is genuinely nothing to report rather than something
 * unknown to guess at.
 *
 * `session_start` ALSO RECORDS THIS RUN'S OWN SESSION FILE:
 * `ctx.sessionManager.getSessionFile()` is the only place in this process
 * that ever answers "what is my own transcript path" - see
 * `runnerReporting.ts`'s header for why the value has to come from here
 * (the child) rather than be derived by the parent. `RunnerReporting`
 * validates and retains it while `RunnerBootstrap` writes it before the
 * ready handshake. `getSessionFile()` can return `undefined` (no persisted
 * transcript for this run); that case is simply not recorded, the same
 * "omit rather than guess" shape as `unansweredAsks`/`teamContext` above.
 */
export interface RunnerLifecycleRuntime {
  readonly pollScheduler: PollSchedulerContract;
  readonly bootstrap: RunnerBootstrapContract;
  readonly execution: RunnerExecutionContract;
  readonly reporting: Pick<RunnerReportingContract, 'recordSessionFile'>;
}

export function registerRunnerLifecycle(
  pi: ExtensionAPI,
  runtime: RunnerLifecycleRuntime = createTeamPromptRuntime(),
): void {
  const runId = process.env[SUBAGENT_RUN_ID_ENV]?.trim();
  if (!runId) return;

  const { pollScheduler, bootstrap, execution, reporting } = runtime;

  let resolved: { teamContext: TeamMemberContext | undefined } | undefined;
  let cumulativeTokens: number | undefined;
  let toolCount = 0;
  const countedMessages = new WeakSet<object>();

  onEvent(pi, 'session_start', (_event, ctx) => {
    if (resolved) return;
    pollScheduler.start();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const recordedSessionFile = sessionFile ? reporting.recordSessionFile(sessionFile) : undefined;
    const bootstrapped = bootstrap.bootstrap(runId, recordedSessionFile);
    if (bootstrapped.teamContext) Object.assign(process.env, nativeTeamMemberEnvironment(bootstrapped.teamContext));
    // `onSteer` is the delivery half of `DeliverableGuard.deliverNudge`'s
    // write side (see `RunnerExecutionHandlers.onSteer`'s own doc, which
    // cross-references it): `deliverNudge` drops a request into this run's
    // OWN steer-requests queue via `requestAsyncSteer`, and
    // `ControlChannelWatcher` (wired up by `execution.start()` below) claims
    // it and calls this handler. Without it, `execution.start()` still
    // claims and commits the nudge - `deliverNudge` reports
    // `nudgeDelivered: true`, `status.json` still shows `needs_attention` -
    // but the request is silently discarded before it ever reaches the
    // child's own conversation. `formatSteerMessage`/`sendUserMessage` are
    // the exact same delivery this file already uses for
    // `registerSteeringInbox`'s separate queue.
    execution.start(runId, {
      onSteer: (request) => {
        const sendUserMessage = (
          pi as { sendUserMessage?: (content: string, options: { deliverAs: 'steer' }) => unknown }
        ).sendUserMessage;
        if (!sendUserMessage) {
          acknowledgeRunnerSteer(request, 'failed', 'Child Pi session does not support sendUserMessage steering.');
          return;
        }
        try {
          sendUserMessage(formatSteerMessage(request), { deliverAs: 'steer' });
          acknowledgeRunnerSteer(request, 'delivered', 'Pi accepted the correlated steering input.');
        } catch (error) {
          acknowledgeRunnerSteer(request, 'failed', error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });
    resolved = { teamContext: bootstrapped.teamContext };
    execution.setActivity('working');
  });

  onEvent(pi, 'agent_start', () => {
    if (resolved) execution.setActivity('working');
  });
  onEvent<{ message?: ChildTranscriptMessage }>(pi, 'message_update', (event) => {
    if (!resolved || !event.message) return;
    const currentTool = getMessageActivity(event.message);
    if (currentTool) execution.setProgress({ currentTool });
  });
  onEvent<{ message?: ChildTranscriptMessage }>(pi, 'message_end', (event) => {
    if (!resolved || !event.message || typeof event.message !== 'object') return;
    if (countedMessages.has(event.message)) return;
    countedMessages.add(event.message);
    const messageTokens = getMessageUsageTokens(event.message);
    if (messageTokens === undefined) return;
    cumulativeTokens = (cumulativeTokens ?? 0) + messageTokens;
    execution.setProgress({ tokens: cumulativeTokens });
  });
  onEvent<{ toolName?: string; tool?: { name?: string }; args?: Record<string, unknown> }>(
    pi,
    'tool_execution_start',
    (event) => {
      if (!resolved) return;
      const toolName = event.toolName ?? event.tool?.name;
      toolCount += 1;
      execution.setProgress({
        toolCount,
        ...(typeof toolName === 'string' && toolName.length > 0
          ? { currentTool: formatToolActivity(toolName, event.args) }
          : {}),
      });
      execution.setActivity(
        toolName === NATIVE_TEAM_TOOL_NAME && event.args?.action === 'ask' ? 'waiting_for_reply' : 'tool',
      );
    },
  );
  onEvent(pi, 'tool_execution_end', () => {
    if (!resolved) return;
    execution.setProgress({ currentTool: 'working' });
    execution.setActivity('working');
  });
  onEvent<{ messages: DeliverableCheckMessage[] }>(pi, 'agent_end', (event) => {
    if (!resolved) return; // session_start has not bootstrapped yet; nothing to report against.
    execution.setActivity('finalizing');
    const summary = extractAssistantSummaryText(event.messages);
    execution.complete(true, summary);
  });
}

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
  'subagent-orchestration-instructions',
  'subagent-slash-result',
  'subagent-slash-text-result',
  'subagent-notify',
  'subagent_control_notice',
  'subagent-control',
  'subagent-control-notice',
]);
const SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN = /<name>\s*pi-subagents\s*<\/name>/;
const PROJECT_CONTEXT_HEADER = '\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n';
const SKILLS_HEADER = '\n\nThe following skills provide specialized instructions for specific tasks.';
const DATE_HEADER = '\nCurrent date:';

function readBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return value !== '0';
}

function readRequiredChildTools(): string[] | undefined {
  const encoded = process.env[REQUIRED_CHILD_TOOLS_ENV]?.trim();
  if (!encoded) return undefined;
  const required = JSON.parse(encoded) as unknown;
  if (!Array.isArray(required) || required.some((name) => typeof name !== 'string' || !name)) {
    throw new Error(`Invalid ${REQUIRED_CHILD_TOOLS_ENV} payload.`);
  }
  return required;
}

function readMcpDirectChildTools(): string[] | undefined {
  const encoded = process.env[MCP_DIRECT_CHILD_TOOLS_ENV]?.trim();
  if (!encoded) return undefined;
  try {
    const tools = JSON.parse(encoded) as unknown;
    if (!Array.isArray(tools) || tools.some((name) => typeof name !== 'string' || !name)) return undefined;
    return tools;
  } catch {
    return undefined;
  }
}

function refreshChildToolDiagnostic(pi: ExtensionAPI): ChildToolDiagnostic | undefined {
  const filePath = process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV]?.trim();
  const required = readRequiredChildTools();
  if (!filePath || !required) return undefined;
  const available = pi.getAllTools().map((tool) => tool.name);
  return writeChildToolDiagnostic(
    filePath,
    required,
    available,
    process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim(),
    readMcpDirectChildTools(),
  );
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
  let endIndex = prompt.length;
  for (const header of nextHeaders) {
    const index = prompt.indexOf(header, startIndex);
    if (index !== -1 && index < endIndex) {
      endIndex = index;
    }
  }
  return endIndex;
}

export function stripProjectContext(prompt: string): string {
  const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
  if (startIndex === -1) return prompt;
  const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
  return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
  const startIndex = prompt.indexOf(SKILLS_HEADER);
  if (startIndex === -1) return prompt;
  const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
  return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
  return prompt
    .replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, '\n\n')
    .replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) =>
      SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? '' : block,
    );
}

function stripChildBoundaryInstructions(prompt: string): string {
  let rewritten = prompt;
  for (const injectedInstructions of [
    CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
    CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
    STRUCTURED_OUTPUT_INSTRUCTIONS,
  ]) {
    rewritten = rewritten.split(injectedInstructions).join('');
  }
  return rewritten.replace(/^(?:[ \t]*\r?\n)+/, '');
}

export function rewriteSubagentPrompt(
  prompt: string,
  options: { inheritProjectContext: boolean; inheritSkills: boolean; fanoutChild?: boolean },
): string {
  let rewritten = prompt;
  if (!options.inheritProjectContext) {
    rewritten = stripProjectContext(rewritten);
  }
  if (!options.inheritSkills) {
    rewritten = stripInheritedSkills(rewritten);
  }
  rewritten = stripSubagentOrchestrationSkill(rewritten);
  rewritten = stripChildBoundaryInstructions(rewritten);
  const boundary = options.fanoutChild ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
  const structured = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] ? `\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}` : '';
  return `${boundary}${structured}\n\n${rewritten}`;
}

function isParentOnlySubagentMessage(message: unknown): boolean {
  const m = message as { role?: string; customType?: string };
  if (m?.role !== 'custom' || typeof m.customType !== 'string') return false;
  return PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType);
}

function isSubagentToolResultMessage(message: unknown): boolean {
  const m = message as { role?: string; toolName?: string };
  return m?.role === 'toolResult' && m.toolName === 'subagent';
}

function isSubagentToolCallBlock(block: unknown): boolean {
  const b = block as { type?: string; name?: string };
  return b?.type === 'toolCall' && b.name === 'subagent';
}

function stripAssistantSubagentToolCallBlocks(message: unknown): unknown {
  const m = message as { role?: string; content?: unknown };
  if (m?.role !== 'assistant' || !Array.isArray(m.content)) return message;
  const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
  if (filteredContent.length === m.content.length) return message;
  if (filteredContent.length === 0) return undefined;
  return { ...m, content: filteredContent };
}

export function stripParentOnlySubagentMessages(messages: unknown[]): unknown[] {
  const preserveCurrentFanoutToolHistory = process.env[SUBAGENT_FANOUT_CHILD_ENV] === '1';
  let changed = false;
  const filtered: unknown[] = [];
  for (const message of messages) {
    if (
      isParentOnlySubagentMessage(message) ||
      (!preserveCurrentFanoutToolHistory && isSubagentToolResultMessage(message))
    ) {
      changed = true;
      continue;
    }
    const stripped = preserveCurrentFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
    if (stripped === undefined) {
      changed = true;
      continue;
    }
    if (stripped !== message) changed = true;
    filtered.push(stripped);
  }
  return changed ? filtered : messages;
}

export function formatSteerMessage(request: SteerRequest): string {
  return [
    'Mid-run steering from the parent orchestrator:',
    '',
    request.message,
    '',
    'Incorporate this guidance at the next safe point. Do not restart the task unless the guidance explicitly asks you to.',
  ].join('\n');
}

function acknowledgeRunnerSteer(request: SteerRequest, state: 'delivered' | 'failed', message: string): void {
  const ackDir = process.env[SUBAGENT_STEER_ACK_DIR_ENV]?.trim();
  const childIndex = Number(process.env[SUBAGENT_CHILD_INDEX_ENV]);
  if (!ackDir || !Number.isInteger(childIndex) || childIndex < 0) return;
  writeSteerAckAt(steerAckPathFromDir(ackDir, request.id), {
    requestId: request.id,
    index: childIndex,
    ts: Date.now(),
    state,
    message,
  });
}

function registerToolBudget(
  pi: ExtensionAPI,
  budget: ResolvedToolBudget | undefined,
  diagnostics: PromptRuntimeDiagnostics,
): void {
  if (!budget) return;
  let toolCount = 0;
  let softNudged = false;
  const sendUserMessage = (pi as { sendUserMessage?: (content: string, options: { deliverAs: 'steer' }) => unknown })
    .sendUserMessage;
  onEvent<{ toolName?: string }>(pi, 'tool_call', (event) => {
    const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
    toolCount++;
    if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
      softNudged = true;
      try {
        sendUserMessage?.(toolBudgetSoftNudge(budget, toolCount), { deliverAs: 'steer' });
      } catch (error) {
        // Advisory nudge only; the child's own output is what matters. Recorded
        // rather than discarded so a host that never accepts steering is
        // discoverable instead of silently dropping every nudge.
        diagnostics.steerNudgeFailures += 1;
        diagnostics.lastError = error;
      }
    }
    if (!shouldBlockToolForBudget(budget, toolName, toolCount)) return undefined;
    return { block: true, reason: toolBudgetBlockedMessage(budget, toolName, toolCount) };
  });
}

/**
 * Deliver mid-run steer requests queued for THIS child (by fan-out index)
 * into its own session via `sendUserMessage`. See the module doc's FIX for
 * why this claims each request individually rather than batch-deleting.
 */
export function registerSteeringInbox(
  pi: ExtensionAPI,
  deps: {
    watch?: typeof fs.watch;
    nativeRealpath?: (filePath: string) => string;
    diagnostics?: PromptRuntimeDiagnostics;
  } = {},
): void {
  const diagnostics = deps.diagnostics ?? createPromptRuntimeDiagnostics();
  const steerInbox = process.env[SUBAGENT_STEER_INBOX_ENV]?.trim();
  if (!steerInbox) return;
  const capabilityPath = process.env[SUBAGENT_STEER_CAPABILITY_ENV]?.trim();
  const ackDir = process.env[SUBAGENT_STEER_ACK_DIR_ENV]?.trim();
  const sendUserMessage = (pi as { sendUserMessage?: (content: string, options: { deliverAs: 'steer' }) => unknown })
    .sendUserMessage;
  const childIndex = Number(process.env[SUBAGENT_CHILD_INDEX_ENV]);
  const pending = new Map<string, string[]>();
  let disposed = false;
  let flushing = false;
  let started = false;
  const canSteer = typeof sendUserMessage === 'function';
  let watcher: fs.FSWatcher | undefined;
  let interval: NodeJS.Timeout | undefined;

  const acknowledge = (request: SteerRequest, state: 'delivered' | 'failed', message: string): void => {
    if (!ackDir || !Number.isInteger(childIndex) || childIndex < 0) return;
    writeSteerAckAt(steerAckPathFromDir(ackDir, request.id), {
      requestId: request.id,
      index: childIndex,
      ts: Date.now(),
      state,
      message,
    });
  };
  const publishCapability = (): void => {
    if (!capabilityPath || !Number.isInteger(childIndex) || childIndex < 0) return;
    writeSteerCapabilityAt(capabilityPath, {
      index: childIndex,
      pid: process.pid,
      readyAt: Date.now(),
      supported: canSteer,
    });
  };

  const flush = (): void => {
    if (disposed || flushing) return;
    flushing = true;
    try {
      for (const claim of claimSteerRequestsFromDir(steerInbox)) {
        if (!canSteer || typeof sendUserMessage !== 'function') {
          acknowledge(claim.request, 'failed', 'Child Pi session does not support sendUserMessage steering.');
          claim.commit();
          continue;
        }
        const formatted = formatSteerMessage(claim.request);
        const ids = pending.get(formatted) ?? [];
        ids.push(claim.request.id);
        pending.set(formatted, ids);
        try {
          sendUserMessage(formatted, { deliverAs: 'steer' });
          claim.commit();
        } catch (error) {
          ids.pop();
          if (ids.length === 0) pending.delete(formatted);
          // Recoverable: this claim goes back to the queue for the next
          // flush to retry, instead of being lost. See the module doc's FIX.
          claim.release();
          acknowledge(claim.request, 'failed', error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      flushing = false;
    }
  };
  const onInput = (event: unknown): undefined => {
    if (disposed || !event || typeof event !== 'object') return undefined;
    const input = event as { source?: unknown; streamingBehavior?: unknown; text?: unknown; content?: unknown };
    if (input.source !== 'extension' || input.streamingBehavior !== 'steer') return undefined;
    const text =
      typeof input.text === 'string' ? input.text : typeof input.content === 'string' ? input.content : undefined;
    if (!text) return undefined;
    const ids = pending.get(text);
    const requestId = ids?.shift();
    if (!requestId) return undefined;
    if (ids?.length === 0) pending.delete(text);
    acknowledge(
      { type: 'steer', id: requestId, ts: Date.now(), message: text },
      'delivered',
      'Pi accepted the correlated steering input.',
    );
    return undefined;
  };
  const start = (): void => {
    if (started || disposed) return;
    try {
      fs.mkdirSync(steerInbox, { recursive: true });
      publishCapability();
    } catch {
      // No channel to report a startup failure on from inside the child;
      // the parent observes a missing capability file and treats it as
      // "steering unsupported for this child" on its own.
      return;
    }
    started = true;
    try {
      watcher = (deps.watch ?? fs.watch)(resolveWatchPath(steerInbox, deps.nativeRealpath), () => flush());
      watcher.on('error', (error) => {
        // fs.watch emits on transient FS errors and the interval poll below
        // keeps delivery live regardless, so this is not fatal. Recorded so a
        // watch that fails on every event is distinguishable from a quiet inbox.
        diagnostics.watchErrors += 1;
        diagnostics.lastError = error;
      });
    } catch {
      watcher = undefined;
    }
    interval = setInterval(flush, STEER_FLUSH_POLL_INTERVAL_MS);
    interval.unref?.();
  };
  const activate = (): undefined => {
    start();
    flush();
    return undefined;
  };

  // Register input before the watcher so an accepted extension input cannot race request dispatch.
  onEvent(pi, 'input', onInput);
  onEvent(pi, 'session_start', () => start());
  for (const eventName of [
    'message_start',
    'message_update',
    'message_end',
    'tool_execution_start',
    'tool_execution_end',
    'turn_end',
  ] as const) {
    onEvent(pi, eventName, activate);
  }
  onEvent(pi, 'session_shutdown', () => {
    disposed = true;
    try {
      watcher?.close();
    } catch (error) {
      // Best effort; the process is shutting down regardless. Still recorded,
      // because a close that always fails is a leaked descriptor per run.
      diagnostics.watchCloseFailures += 1;
      diagnostics.lastError = error;
    }
    if (interval) clearInterval(interval);
  });
}

/**
 * `diagnostics` is optional and defaults to a fresh object: the `.cts` entry
 * point calls this with a single argument (`pi`), matching the host contract
 * `resolveRuntimeExtensionPath` resolves onto every child's `--extension`
 * args, so that call keeps working unchanged. A caller that wants to observe
 * what this runtime absorbed - see `PromptRuntimeDiagnostics` - passes its
 * own object and keeps the reference; this function only ever mutates it, it
 * never owns or resets it.
 */
export function installSubagentPromptRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  diagnostics: PromptRuntimeDiagnostics = createPromptRuntimeDiagnostics(),
): void {
  // First, before any scoped path is touched. Pi loads extensions through jiti
  // with `moduleCache: false`, so this extension gets its OWN instance of
  // `shared/paths.ts` - the scope the surrounding runner process adopted is not
  // visible here, and has to be read from the environment again.
  adoptSessionScopeFromEnv();
  registerParentProcessGuard(pi);
  registerSteeringInbox(pi, { diagnostics });
  registerToolBudget(
    pi,
    decodeToolBudgetEnv(process.env[TOOL_BUDGET_ENV], { allowZero: process.env[TOOL_BUDGET_ZERO_AUTH_ENV] === '1' }),
    diagnostics,
  );
  // One explicit graph for this whole child registration. Building another
  // graph inside an individual resolver would duplicate scheduler, reporting,
  // and intercom state in the same process.
  const runtime = createTeamPromptRuntime();
  registerRunnerLifecycle(pi, runtime);
  cordis.effect(
    () => () => {
      runtime.pollScheduler.stop();
      runtime.terminalPersistence.dispose();
    },
    `${PROMPT_RUNTIME_SOURCE}/runner`,
  );

  const teamChannels = runtime.teamChannel;
  let teamRuntime: ReturnType<typeof teamChannels.createRuntime> | undefined;

  onEvent(pi, 'session_start', () => {
    teamRuntime?.dispose();
    teamRuntime = teamChannels.createRuntime(pi);
    teamRuntime.bindChildFromEnvironment();
  });
  cordis.effect(
    () => () => {
      teamRuntime?.dispose();
      teamRuntime = undefined;
    },
    `${PROMPT_RUNTIME_SOURCE}/channel`,
  );
  onEvent(pi, 'agent_start', () => {
    refreshChildToolDiagnostic(pi);
  });
  // `agent_end` intentionally does not drain outstanding work here. See the
  // module doc's "WHAT IS DELIBERATELY NOT WIRED YET" for why.

  const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
  const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
  if (structuredOutputPath && structuredSchemaPath) {
    const schema = JSON.parse(fs.readFileSync(structuredSchemaPath, 'utf-8')) as JsonSchemaObject;
    const parameters = createStructuredOutputToolParameters(schema);
    const validator = new StructuredOutputValidator();
    const registerTool = (
      pi.registerTool as unknown as (tool: {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute: (_id: string, params: { value: unknown }) => Promise<unknown>;
      }) => void
    ).bind(pi);
    registerTool({
      name: 'structured_output',
      label: 'Structured Output',
      description: 'Submit the required final structured output for this subagent step. This terminates the step.',
      parameters: parameters as never,
      async execute(_id: string, params: { value: unknown }) {
        const validation = await validator.validateValue(schema, params.value);
        if (validation.status === 'invalid') {
          throw new Error(`Structured output validation failed: ${validation.message}`);
        }
        fs.mkdirSync(path.dirname(structuredOutputPath), { recursive: true });
        fs.writeFileSync(structuredOutputPath, JSON.stringify(params.value), { mode: 0o600 });
        return {
          content: [{ type: 'text', text: 'Structured output captured.' }],
          details: { path: structuredOutputPath },
          terminate: true,
        };
      },
    });
  }

  onEvent<{ messages: unknown[] }>(pi, 'context', (event) => {
    const messages = stripParentOnlySubagentMessages(event.messages);
    if (messages === event.messages) return undefined;
    return { messages };
  });

  onEvent<{ systemPrompt: string }>(pi, 'before_agent_start', async (event) => {
    const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
    if (intercomSessionName && typeof pi.setSessionName === 'function') {
      pi.setSessionName(intercomSessionName);
    }

    const inheritProjectContext = readBooleanEnv(INHERIT_PROJECT_CONTEXT_ENV);
    const inheritSkills = readBooleanEnv(INHERIT_SKILLS_ENV);
    const fanoutChild = readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV);
    let rewritten = event.systemPrompt;
    if (inheritProjectContext !== undefined || inheritSkills !== undefined || fanoutChild !== undefined) {
      rewritten = rewriteSubagentPrompt(event.systemPrompt, {
        inheritProjectContext: inheritProjectContext ?? true,
        inheritSkills: inheritSkills ?? true,
        fanoutChild: fanoutChild === true,
      });
    }
    if (rewritten === event.systemPrompt) return;
    return { systemPrompt: rewritten };
  });
}

interface PromptRuntimePluginConfig {
  readonly pi: ExtensionAPI;
  readonly diagnostics?: PromptRuntimeDiagnostics;
}

function promptRuntimePlugin(cordis: Context, config: PromptRuntimePluginConfig): void {
  installSubagentPromptRuntime(cordis, config.pi, config.diagnostics);
}

/** Private child-process Pi factory, mounted into the shared or standalone Cordis host. */
export async function registerSubagentPromptRuntime(
  pi: ExtensionAPI,
  diagnostics?: PromptRuntimeDiagnostics,
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PROMPT_RUNTIME_SOURCE);
  const fiber = connection.root.plugin(promptRuntimePlugin, { pi, ...(diagnostics ? { diagnostics } : {}) });
  try {
    await fiber;
  } catch (error) {
    await fiber.dispose();
    await connection.dispose();
    throw error;
  }

  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}
