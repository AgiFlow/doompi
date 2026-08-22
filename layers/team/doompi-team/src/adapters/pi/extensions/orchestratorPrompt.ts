/**
 * The system-prompt addendum that teaches a parent session how to orchestrate.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT MORE TOOL-DESCRIPTION TEXT:
 * Until this module, every piece of orchestration guidance this package had
 * lived inside the `subagent` tool's own description. That is the wrong
 * surface for it twice over. A tool description is read as "how do I call this
 * thing", so behavioural rules ("choose what to do after launching", "synthesize
 * before delegating again") compete for attention with call mechanics and lose.
 * And a description is only consulted when the model is already considering
 * that tool, whereas the rule that matters most - do not delegate work you
 * should just do - has to land BEFORE it reaches for the tool at all.
 *
 * So this is a MOVE, not an addition: the behavioural half of
 * `toolDescription.ts` came here, and the description kept the mechanics.
 * Token cost is close to neutral; placement is strictly better.
 *
 * WHY IT IS DEFAULT-ON:
 * `doom-pi` loads this extension in every session, so an opt-in flag would
 * mean nearly every session runs without it - which is today's behaviour and
 * today's problem. `ExtensionConfig.orchestratorPrompt: false` is the escape
 * hatch for a session that wants the tools without the guidance.
 *
 * KEEP THIS SHORT. It is prepended to every turn of every session. Anything
 * that is really call mechanics belongs in the tool description; anything that
 * is really package trivia belongs in a doc nobody pays per-turn for.
 */

/**
 * Marker used to detect an addendum this package already appended, so a repeat
 * `before_agent_start` (or a host that replays the hook) cannot stack two
 * copies into one prompt.
 */
export const ORCHESTRATOR_PROMPT_MARKER = '## Delegating to subagents';

export const ORCHESTRATOR_PROMPT = `${ORCHESTRATOR_PROMPT_MARKER}

You can delegate work to subagent runs. Doing so well is a skill; doing it
reflexively wastes time and tokens.

**Do it yourself when you can.** A task you can finish with your own tools in a
few steps should not become a subagent. Do not delegate merely because an agent
is available, a plan has multiple items, or a task can be stated separately.
Delegation pays for itself only when work is independently parallel with
meaningful wall-clock savings, long enough to justify process and cold-context
costs, or materially better in a fresh context.

**Launches return immediately.** \`{action:"run", requests:[...]}\` returns run
handles after startup, not completion. After launching, choose whether to keep
doing useful work that does not duplicate the delegated scope, or end your turn.
Do not sleep or poll status in a loop. Completion messages wake you
automatically.

**Results arrive as messages, not return values.** A finished run shows up as a
completion message carrying its run id, its summary, and the handling it needs.
Act on it: incorporate the finding, reject it with a reason, or say why it does
not apply. Never acknowledge one passively, and never invent or predict a
result that has not arrived. Use the run id it gives you to follow up -
\`{action:"status", id, transcriptLines:80}\` for recent output, or
\`{action:"steer", id, message}\` to redirect a live Pi child.

**Workers cannot see this conversation.** Every task string must stand alone:
the goal, the paths, the constraints, the expected output. When you delegate
follow-up work after a research run, read the findings first and write the next
prompt with the specific files and changes in it. Writing "based on your
findings" hands your own understanding to someone who does not have it.

**Known context is a handoff, not a hint.** Put parent-verified paths and facts
in a clearly labeled parent context pack. Tell the worker to read known paths
directly before broad discovery; the pack satisfies generic initial-context
exploration. Widen only for a concrete missing dependency, not a repository
inventory.

**Children are not orchestrators.** Give every child a self-contained task.
Tool availability, including coordination, is controlled by Team package policy
and any active capability ceiling. Children must not assume they can contact main or delegate further.`;

export interface OrchestratorPromptConfig {
  /** `false` disables the addendum. Any other value, including absent, enables it. */
  orchestratorPrompt?: boolean;
}

/** Whether this session should receive the addendum. */
export function shouldInjectOrchestratorPrompt(config: OrchestratorPromptConfig): boolean {
  return config.orchestratorPrompt !== false;
}

/**
 * Append the addendum to a session's system prompt.
 *
 * Idempotent by marker rather than by a registration guard: the caller is a
 * per-turn hook, and the same base prompt reaching it twice must not produce a
 * prompt carrying the guidance twice.
 */
export function appendOrchestratorPrompt(systemPrompt: string | undefined): string {
  if (systemPrompt?.includes(ORCHESTRATOR_PROMPT_MARKER)) return systemPrompt;
  return systemPrompt ? `${systemPrompt}\n\n${ORCHESTRATOR_PROMPT}` : ORCHESTRATOR_PROMPT;
}
