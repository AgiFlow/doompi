/**
 * Cross-call behaviour the schema cannot express.
 *
 * Every rule lives in exactly one surface. Argument-site mechanics belong to
 * the parameter descriptions in `schemas/task.ts`, the use/do-not-use policy
 * and session scoping belong to the tool description, and general delegation
 * judgement belongs to the Team orchestrator prompt. What is left here is what
 * none of those three can carry: how calls should be sequenced across a turn.
 */
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
  'Batch the whole plan in one upsert: {"action":"upsert","tasks":[{"subject":"Research the store"},{"subject":"Write the reducer"}]}. Report progress one call at a time: mark a task in_progress before you start it and completed the moment it lands, never batched at the end of a turn. Keep one task in_progress for your own work; delegated tasks run in parallel and do not count.',
  'Never mark a task completed while tests fail or the work is partial. Use failed, or keep it in_progress and add a task for the blocker in the same upsert.',
  'When every non-deleted task is completed, review the list once and call {"action":"clear"}.',
  "Status flow: pending, in_progress, completed. failed is recoverable, deleted is a tombstone. Pass activeForm (e.g. 'writing tests') when marking in_progress.",
  'upsert applies each entry independently: passing entries commit and failures are reported by array index. Resend only the corrected failures, because resending an applied entry with no id creates a duplicate task.',
  'Apply the session delegation criteria before choosing what to delegate, then call subagent {"action":"agents"} and use an exact discovered name. Prefer a general-purpose write-capable agent such as delegate or worker when no specialist fits, and use a focused inlineAgent only for read-only work.',
  'Assign through assignments[] even for a single task: {"action":"assign","assignments":[{"id":1,"agent":"researcher"}]}. Put independent ready tasks in one batch rather than repeated calls or multi_tool, and do not start a direct subagent run for work already on the task list. Successful entries keep running when another entry fails, so retry only the failures.',
  'Fill relevantFiles only with files you actually read or located, and priorFindings only with verified facts in a few lines, not directives. A guessed path costs more than an omitted one.',
  'Subject stays short and imperative. description is the durable brief handed to the subagent, extended at assign time by instructions, relevantFiles and priorFindings, so do not repeat one in the other.',
  'When a delegated task completes and unblocks another, reconsider it promptly. If a child asks for a decision or an assignment fails to start, respond, rescope or retry instead of leaving it pending. Doom Task records delegated lifecycle and results on the task itself.',
];
