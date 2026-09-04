import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type DelegationAccepted,
  type DelegationCancel,
  type DelegationResult,
  type DelegationRequest,
  type DelegationStarted,
  type DelegationUpdate,
  DOOM_DELEGATION_ACCEPTED_EVENT,
  DOOM_DELEGATION_CANCELLED_EVENT,
  DOOM_DELEGATION_FINISHED_EVENT,
  DOOM_DELEGATION_REQUESTED_EVENT,
  DOOM_DELEGATION_STARTED_EVENT,
  DOOM_DELEGATION_UPDATED_EVENT,
  type DoomDelegationService,
} from '@agimon-ai/doompi-extension-contracts/delegation';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  DelegationManager,
  type DelegationManagerOptions,
  type DelegationNotifier,
  type DelegationPlatform,
  ERR_CANCEL_UNACKNOWLEDGED,
  ERR_CHILD_SESSION,
  ERR_NO_RUNTIME,
  MAX_BRIEF_FILES,
} from '../src/exports/delegation/manager';
import { TASK_EVENT, type TaskErrorSink, type TaskEventSink } from '../src/exports/logSinkTelemetry';
import { narrateTaskCommit } from '../src/services/narration/taskNarration.ts';
import { resolveSessionKey, resolveStorePath } from '../src/exports/store/paths';
import { applyTaskMutation } from '../src/exports/store/reducer';
import { TaskStore } from '../src/exports/store/taskStore';
import type { Task } from '../src/exports/store/types';
import { DEFAULT_PROMPT_GUIDELINES } from '../src/exports/tool/promptGuidelines';
import { TaskParamsSchema } from '../src/schemas/task.ts';

/** Minimal Team service mounted on a real Cordis root. */
class FakeBus {
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  readonly root = new Context();
  private readonly service: DoomDelegationService = {
    sessionId: 'session-1',
    generation: 'test-generation',
    request: async (request) => {
      this.emitted.push({ channel: DOOM_DELEGATION_REQUESTED_EVENT, data: request });
    },
    cancel: (request) => {
      this.emitted.push({ channel: DOOM_DELEGATION_CANCELLED_EVENT, data: request });
    },
  };

  bind(manager: DelegationManager): void {
    manager.bind(this.root, this.service);
  }

  emit(channel: string, data: unknown): void {
    const payload = this.normalizePayload(data);
    if (channel === DOOM_DELEGATION_ACCEPTED_EVENT) {
      delete payload.runId;
      this.root.emit(DOOM_DELEGATION_ACCEPTED_EVENT, payload as unknown as DelegationAccepted);
    } else if (channel === DOOM_DELEGATION_STARTED_EVENT) {
      this.root.emit(DOOM_DELEGATION_STARTED_EVENT, payload as unknown as DelegationStarted);
    } else if (channel === DOOM_DELEGATION_UPDATED_EVENT) {
      this.root.emit(DOOM_DELEGATION_UPDATED_EVENT, payload as unknown as DelegationUpdate);
    } else if (channel === DOOM_DELEGATION_FINISHED_EVENT) {
      this.root.emit(DOOM_DELEGATION_FINISHED_EVENT, payload as unknown as DelegationResult);
    } else if (channel === DOOM_DELEGATION_CANCELLED_EVENT) {
      this.service.cancel(payload as unknown as DelegationCancel);
    }
  }

  lastRequest(): DelegationRequest {
    const entry = [...this.emitted].reverse().find((item) => item.channel === DOOM_DELEGATION_REQUESTED_EVENT);
    return entry?.data as DelegationRequest;
  }

  private normalizePayload(data: unknown): Record<string, unknown> {
    const payload = { ...(data as Record<string, unknown>) };
    delete payload.version;
    if (typeof payload.requestId === 'string' && typeof payload.runId !== 'string') {
      payload.runId = `run:${payload.requestId}`;
    }
    return payload;
  }
}

const SUBAGENT_DELEGATION_ACCEPTED_EVENT = DOOM_DELEGATION_ACCEPTED_EVENT;
const SUBAGENT_DELEGATION_CANCEL_EVENT = DOOM_DELEGATION_CANCELLED_EVENT;
const SUBAGENT_DELEGATION_RESPONSE_EVENT = DOOM_DELEGATION_FINISHED_EVENT;
const SUBAGENT_DELEGATION_STARTED_EVENT = DOOM_DELEGATION_STARTED_EVENT;
const SUBAGENT_DELEGATION_UPDATE_EVENT = DOOM_DELEGATION_UPDATED_EVENT;

let directory: string;
let storePath: string;
let store: TaskStore;
let bus: FakeBus;
let notify: Mock<DelegationNotifier>;
let narrate: Mock<(text: string) => void>;
let report: { error: Mock<TaskErrorSink>; warn: Mock<TaskErrorSink>; event: Mock<TaskEventSink> };
let manager: DelegationManager;
let nextRequestId = 0;

function createTestPlatform(environment: Readonly<Record<string, string | undefined>>): DelegationPlatform {
  return {
    environment,
    processId: process.pid,
    createRequestId: () => `request-${++nextRequestId}`,
    formatBriefPath: (entry, cwd) => {
      if (!path.isAbsolute(entry)) return path.normalize(entry);
      const relative = path.relative(cwd, entry);
      return relative && !relative.startsWith('..') ? relative : entry;
    },
  };
}

function flush(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seed(subject: string, blockedBy?: number[]): Promise<Task> {
  const { value } = await store.mutate((document) => {
    const result = applyTaskMutation(document, 'upsert', {
      tasks: [{ subject, ...(blockedBy ? { blockedBy } : {}) }],
    });
    return { document: result.document, value: result.document.tasks.at(-1)! };
  });
  return value;
}

function taskById(id: number): Task | undefined {
  return store.read().tasks.find((task) => task.id === id);
}

function makeManager(
  env: NodeJS.ProcessEnv = {},
  overrides: Partial<DelegationManagerOptions> = {},
): DelegationManager {
  const created = new DelegationManager({
    store,
    cwd: directory,
    platform: createTestPlatform(env),
    notify,
    getSessionId: () => 'session-1',
    startedTimeoutMs: 60,
    onNotifyError: vi.fn(),
    report,
    ...overrides,
  });
  bus.bind(created);
  return created;
}

beforeEach(() => {
  nextRequestId = 0;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-task-delegation-'));
  storePath = path.join(directory, 'tasks.json');
  narrate = vi.fn();
  store = new TaskStore({
    storePath,
    onCommitted: (previous, committed) => narrateTaskCommit({ narrate }, previous, committed),
  });
  bus = new FakeBus();
  notify = vi.fn();
  report = { error: vi.fn(), warn: vi.fn(), event: vi.fn() };
  manager = makeManager();
});

afterEach(async () => {
  vi.restoreAllMocks();
  manager.dispose();
  await bus.root.fiber.dispose();
  store.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('prompt-led allocation guidance', () => {
  it('requires discovery, tracked fan-out, dependency follow-up, and explicit recovery', () => {
    const guidelines = DEFAULT_PROMPT_GUIDELINES.join('\n');

    expect(guidelines).toContain('call subagent {"action":"agents"}');
    expect(guidelines).toContain('use an exact discovered name');
    expect(guidelines).toContain('Prefer a general-purpose write-capable agent such as delegate or worker');
    expect(guidelines).toContain('focused inlineAgent only for read-only work');
    expect(guidelines).toContain('Apply the session delegation criteria before choosing what to delegate');
    expect(guidelines).toContain('Assign through assignments[] even for a single task');
    expect(guidelines).toContain('Put independent ready tasks in one batch');
    expect(guidelines).toContain('"assignments":[{"id":1,"agent":"researcher"}');
    expect(guidelines).toContain('rather than repeated calls or multi_tool');
    expect(guidelines).toContain('do not start a direct subagent run for work already on the task list');
    expect(guidelines).toContain('Successful entries keep running when another entry fails');
    expect(guidelines).toContain('retry only the failures');
    expect(guidelines).toContain('reconsider it promptly');
    expect(guidelines).toContain('If a child asks for a decision');
    expect(guidelines).toContain('an assignment fails to start');
  });

  /** The single-entry form is a schema rule, so it is pinned where it is stated. */
  it('states the assignments[] entry rule on the parameters, not in the guidelines', () => {
    const parameters = JSON.stringify(TaskParamsSchema);

    expect(parameters).toContain('Required for assign, one entry per task, including when there is only one');
    expect(parameters).toContain('Not accepted by upsert or assign');
  });

  it('documents Task-specific context fields without repeating Team handoff policy', () => {
    const guidelines = DEFAULT_PROMPT_GUIDELINES.join('\n');

    expect(guidelines).toContain('Fill relevantFiles only with files you actually read or located');
    expect(guidelines).toContain('priorFindings only with verified facts');
    expect(guidelines).toContain('guessed path costs more than an omitted one');
    expect(guidelines).toContain('in a few lines, not directives');
    expect(guidelines).toContain('extended at assign time by instructions, relevantFiles and priorFindings');
    expect(guidelines).toContain('do not repeat one in the other');
    expect(guidelines).not.toContain('A fresh-context child starts with none of your context');
    expect(guidelines).not.toContain('reads known paths directly');
    expect(guidelines).not.toContain('widens discovery only for a concrete missing dependency');
  });

  it('leaves general delegation behavior to the Team orchestrator prompt', () => {
    const guidelines = DEFAULT_PROMPT_GUIDELINES.join('\n');

    expect(guidelines).not.toContain('Assign every unblocked pending task');
    expect(guidelines).not.toContain('After assigning work, continue non-overlapping parent work or end your turn');
    expect(guidelines).not.toContain('Do not poll in a loop');
    expect(guidelines).not.toContain('Completion notifications wake the parent session');
    expect(guidelines).not.toContain('Read the completion or failure result before deciding what to do next');
    expect(guidelines).toContain('Doom Task records delegated lifecycle and results on the task itself');
  });

  it('permits batching a plan while still forbidding batched progress', () => {
    const guidelines = DEFAULT_PROMPT_GUIDELINES.join('\n');

    expect(guidelines).toContain('Batch the whole plan in one upsert');
    expect(guidelines).toContain('Report progress one call at a time');
    expect(guidelines).toContain('never batched at the end of a turn');
    expect(guidelines).toContain('delegated tasks run in parallel and do not count');
    expect(guidelines).toContain('Resend only the corrected failures');
    expect(guidelines).toContain('resending an applied entry with no id creates a duplicate task');
  });
});

describe('assign context pack', () => {
  function assignedEvent(): Record<string, unknown> {
    const call = report.event.mock.calls.find(([event]) => event === TASK_EVENT.delegationAssigned);
    return (call?.[1] ?? {}) as Record<string, unknown>;
  }

  function completedEvent(): Record<string, unknown> {
    const call = report.event.mock.calls.find(([event]) => event === TASK_EVENT.delegationCompleted);
    return (call?.[1] ?? {}) as Record<string, unknown>;
  }

  it('renders located files and prior findings ahead of the coordination line', async () => {
    const task = await seed('Fix the reducer');

    await manager.assign(task.id, {
      agent: 'worker',
      relevantFiles: ['src/store/reducer.ts', 'tests/reducer.test.ts'],
      priorFindings: 'applyTaskMutation owns the ref resolution',
    });

    const { prompt } = bus.lastRequest();
    expect(prompt).toContain('Parent context — consume before repository discovery:');
    expect(prompt).toContain(
      '- Parent-verified files (read these first with direct reads): src/store/reducer.ts, tests/reducer.test.ts',
    );
    expect(prompt).toContain(
      '- Established facts (do not re-derive unless direct evidence contradicts them): applyTaskMutation owns the ref resolution',
    );
    expect(prompt).toContain('This pack satisfies initial repository/context exploration.');
    expect(prompt).toContain('Do not begin with repository-wide listing, find, or grep.');
    expect(prompt).toContain('naming a concrete missing dependency or invalid path');
    expect(prompt).not.toContain('the list may be incomplete');
    expect(prompt.indexOf('Parent context')).toBeLessThan(prompt.indexOf('Coordination:'));
  });

  it('relativizes paths inside cwd, keeps outside paths absolute, and drops blanks and repeats', async () => {
    const task = await seed('Trace the handler');
    const outside = path.join(path.sep, 'elsewhere', 'vendor.ts');

    await manager.assign(task.id, {
      agent: 'worker',
      relevantFiles: [path.join(directory, 'src/a.ts'), './src/a.ts', '  ', 'src/a.ts', outside],
    });

    const { prompt } = bus.lastRequest();
    expect(prompt).toContain(`- Parent-verified files (read these first with direct reads): src/a.ts, ${outside}`);
    expect(prompt).not.toContain('..');
  });

  it('renders an established-facts-only pack without an empty file line', async () => {
    const task = await seed('Use a known invariant');

    await manager.assign(task.id, {
      agent: 'worker',
      priorFindings: 'parseConfig already rejects unknown keys',
    });

    const { prompt } = bus.lastRequest();
    expect(prompt).toContain('Parent context — consume before repository discovery:');
    expect(prompt).toContain(
      '- Established facts (do not re-derive unless direct evidence contradicts them): parseConfig already rejects unknown keys',
    );
    expect(prompt).not.toContain('Parent-verified files');
  });

  it('caps the file list and truncates prior findings', async () => {
    const task = await seed('Audit everything');
    const files = Array.from({ length: MAX_BRIEF_FILES + 4 }, (_, index) => `src/file-${index}.ts`);

    await manager.assign(task.id, { agent: 'worker', relevantFiles: files, priorFindings: 'x'.repeat(2000) });

    const { prompt } = bus.lastRequest();
    expect(prompt).toContain(`src/file-${MAX_BRIEF_FILES - 1}.ts`);
    expect(prompt).not.toContain(`src/file-${MAX_BRIEF_FILES}.ts`);
    expect(prompt).toContain('… (truncated)');
    expect(assignedEvent()['delegation.context_file_count']).toBe(MAX_BRIEF_FILES);
  });

  it('records the pack shape and a larger brief on the assignment event', async () => {
    const bare = await seed('Bare assign');
    await manager.assign(bare.id, { agent: 'worker' });
    const bareEvent = assignedEvent();

    expect(bareEvent['delegation.context_present']).toBe(false);
    expect(bareEvent['delegation.context_file_count']).toBe(0);
    expect(bareEvent['delegation.context_notes_length']).toBe(0);
    expect(bareEvent['delegation.agent_name']).toBe('worker');

    report.event.mockClear();
    const packed = await seed('Packed assign');
    await manager.assign(packed.id, {
      agent: 'worker',
      relevantFiles: ['src/a.ts'],
      priorFindings: 'the parser is in a.ts',
    });
    const packedEvent = assignedEvent();

    expect(packedEvent['delegation.context_present']).toBe(true);
    expect(packedEvent['delegation.context_file_count']).toBe(1);
    expect(packedEvent['delegation.context_notes_length']).toBe('the parser is in a.ts'.length);
    expect(packedEvent['delegation.brief_length']).toBeGreaterThan(bareEvent['delegation.brief_length'] as number);
  });

  it('carries the pack shape and the child cost onto the completion event', async () => {
    const task = await seed('Ship it');
    await manager.assign(task.id, { agent: 'worker', relevantFiles: ['src/a.ts'] });
    const { requestId } = bus.lastRequest();

    // An update lands first in a real run: the pack shape must survive it.
    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId });
    await flush();
    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, { version: 1, requestId, toolCount: 3, durationMs: 400 });
    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId,
      status: 'completed',
      toolCount: 9,
      durationMs: 1234,
    });
    await flush();

    const event = completedEvent();
    expect(event['delegation.outcome']).toBe('completed');
    expect(event['delegation.context_present']).toBe(true);
    expect(event['delegation.context_file_count']).toBe(1);
    expect(event['delegation.tool_count']).toBe(9);
    expect(event['delegation.duration_ms']).toBe(1234);
  });

  it('reports a failed outcome without cost metrics when the run never starts', async () => {
    const task = await seed('Never starts');
    await manager.assign(task.id, { agent: 'worker' });
    await flush(120);

    const event = completedEvent();
    expect(event['delegation.outcome']).toBe('failed');
    expect(event['delegation.context_present']).toBe(false);
    expect(event).not.toHaveProperty('delegation.tool_count');
    expect(event).not.toHaveProperty('delegation.duration_ms');
  });
});

describe('assign', () => {
  it('emits a v1 delegation request carrying the task brief', async () => {
    const task = await seed('Add reducer tests');

    const outcome = await manager.assign(task.id, { agent: 'reviewer', instructions: 'focus on edge cases' });

    expect(outcome.ok).toBe(true);
    const request = bus.lastRequest();
    expect(request.requestId).toBe('request-1');
    expect(request.agent).toBe('reviewer');
    expect(request.context).toBeUndefined();
    expect(request.cwd).toBe(directory);
    expect(request.prompt).toContain('Add reducer tests');
    expect(request.prompt).toContain('focus on edge cases');
    expect(request.prompt).toContain('Coordination: work directly without changing the task record');
    expect(request.prompt).toContain('ask main through intercom only for blockers or decisions');
    expect(request.prompt).toContain('report changed files and verification when done');
    expect(request.prompt).not.toContain('Delegation coordination:');
    // The child works the task, it does not write the task record.
    expect(request.prompt).not.toContain('"action":"upsert"');
    expect(request.prompt).not.toContain('status":"in_progress"');
    // No pack supplied means no section headers at all: the brief is the child's
    // whole context, so an empty header would be pure token cost.
    expect(request.prompt).not.toContain('Parent context — consume before repository discovery');
    expect(request.prompt).not.toContain('Parent-verified files');
    expect(request.prompt).not.toContain('Established facts');
    expect(outcome.message).toContain('runs independently of this turn');
    expect(outcome.message).toContain('Continue non-overlapping work, or end your turn');
  });

  it('forwards an explicit fork context without changing it', async () => {
    const task = await seed('Review the current plan');

    await manager.assign(task.id, { agent: 'planner', context: 'fork' });

    expect(bus.lastRequest().context).toBe('fork');
  });

  it('records the delegation on the task and claims ownership', async () => {
    const task = await seed('Add reducer tests');

    await manager.assign(task.id, { agent: 'reviewer', model: 'claude-opus-5' });

    const stored = taskById(task.id);
    expect(stored?.owner).toBe('reviewer');
    expect(stored?.delegation).toMatchObject({ agent: 'reviewer', state: 'requested', model: 'claude-opus-5' });
    expect(stored?.delegation?.pid).toBe(process.pid);
  });

  it('passes a one-shot inline agent through the typed delegation request', async () => {
    const task = await seed('Inspect schemas');

    await manager.assign(task.id, {
      agent: 'schema-explorer',
      inlineAgent: { systemPrompt: 'Inspect schema boundaries without writing files.' },
    });

    expect(bus.lastRequest()).toMatchObject({
      agent: 'schema-explorer',
      inlineAgent: { systemPrompt: 'Inspect schema boundaries without writing files.' },
    });
    expect(taskById(task.id)?.owner).toBe('schema-explorer');
  });

  it('requires an agent name', async () => {
    const task = await seed('Add reducer tests');

    expect(await manager.assign(task.id, {})).toEqual({ ok: false, message: 'agent required for assign' });
  });

  it('refuses a blocked task and names the blockers', async () => {
    const blocker = await seed('First');
    const dependent = await seed('Second', [blocker.id]);

    const outcome = await manager.assign(dependent.id, { agent: 'reviewer' });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`#${blocker.id}`);
  });

  it('refuses a task that is already delegated', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });

    const outcome = await manager.assign(task.id, { agent: 'other' });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('already delegated');
  });

  it('refuses a missing task', async () => {
    expect((await manager.assign(42, { agent: 'reviewer' })).ok).toBe(false);
  });

  it('is unavailable inside a subagent child session', async () => {
    manager.dispose();
    manager = makeManager({ PI_SUBAGENT_CHILD: '1' });
    const task = await seed('Add reducer tests');

    expect(await manager.assign(task.id, { agent: 'reviewer' })).toEqual({ ok: false, message: ERR_CHILD_SESSION });
  });
});

describe('delegation lifecycle', () => {
  it('requests detached execution and persists the acknowledged async run id', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const request = bus.lastRequest() as DelegationRequest & {
      runMode?: string;
      teamTask?: { id: string; subject: string };
    };

    expect(request.runMode).toBe('detached');
    expect(request.teamTask).toEqual({ id: String(task.id), subject: task.subject });
    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, {
      version: 1,
      requestId: request.requestId,
      runId: 'async-task-run',
    });
    await flush();

    expect(taskById(task.id)?.status).toBe('in_progress');
    expect(taskById(task.id)?.delegation).toMatchObject({ state: 'running', runId: 'async-task-run' });
  });

  it('tracks live progress without writing it to the store', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();
    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId });
    await flush();
    const revBefore = store.read().rev;

    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
      version: 1,
      requestId,
      currentTool: 'bash',
      toolCount: 3,
      tokens: 0,
    });

    expect(manager.progressFor(taskById(task.id)!)).toMatchObject({ currentTool: 'bash', toolCount: 3, tokens: 0 });
    expect(store.read().rev).toBe(revBefore);
    expect(JSON.stringify(store.read())).not.toContain('"tokens"');
  });

  it('rebases elapsed runtime monotonically and merges cumulative tokens', async () => {
    let clock = 1000;
    manager.dispose();
    manager = makeManager({}, { nowMs: () => clock });
    const task = await seed('Measure delegated runtime');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();
    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId });
    await flush();

    expect(manager.progressFor(taskById(task.id)!)).toMatchObject({ durationMs: 0, durationObservedAt: 1000 });

    clock = 2000;
    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, { version: 1, requestId, durationMs: 0, tokens: 0 });
    const first = manager.progressFor(taskById(task.id)!)!;
    expect(first).toMatchObject({ durationMs: 1000, durationObservedAt: 2000, tokens: 0 });
    expect(DelegationManager.elapsedMs(first, 2500)).toBe(1500);

    clock = 3000;
    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, { version: 1, requestId, durationMs: 100, tokens: 1200 });
    const second = manager.progressFor(taskById(task.id)!)!;
    expect(second.tokens).toBe(1200);
    expect(second.durationMs).toBe(2000);
    expect(second.durationObservedAt).toBe(3000);

    clock = 3500;
    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, { version: 1, requestId, durationMs: 1500, tokens: 900 });
    const delayed = manager.progressFor(taskById(task.id)!)!;
    expect(delayed.tokens).toBe(1200);
    expect(DelegationManager.elapsedMs(delayed, 3500)).toBeGreaterThanOrEqual(2000);
  });

  it('completes the task and notifies the model on success', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId,
      status: 'completed',
      output: 'all tests pass',
      durationMs: 1200,
    });
    await flush();

    const stored = taskById(task.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.delegation).toMatchObject({ state: 'completed' });
    expect(stored?.delegation?.result?.output).toBe('all tests pass');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ customType: 'doom-task-notify' }), {
      triggerTurn: true,
      deliverAs: 'steer',
    });
    expect(notify.mock.calls[0][0].content).toContain('completed task');
    expect(notify.mock.calls[0][0].content).toContain('task {"action":"clear"}');
  });

  it('keeps the list open when another visible task is unfinished', async () => {
    const task = await seed('Add reducer tests');
    await seed('Run typecheck');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId, status: 'completed' });
    await flush();

    expect(notify.mock.calls[0][0].content).not.toContain('All tasks are completed');
  });

  it('marks the task failed when the run reports an error', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId,
      status: 'timed_out',
      error: 'budget exhausted',
    });
    await flush();

    const stored = taskById(task.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.delegation?.result?.error).toBe('budget exhausted');
  });

  it('returns a cancelled task to pending', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    narrate.mockClear();
    const outcome = await manager.cancel(task.id);

    expect(outcome.ok).toBe(true);
    expect(narrate).not.toHaveBeenCalled();

    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId, status: 'cancelled' });
    await flush();

    expect(bus.emitted.some((entry) => entry.channel === SUBAGENT_DELEGATION_CANCEL_EVENT)).toBe(true);
    expect(taskById(task.id)?.status).toBe('pending');
    expect(taskById(task.id)?.delegation?.state).toBe('cancelled');
    expect(narrate).toHaveBeenCalledOnce();
    expect(narrate).toHaveBeenCalledWith('Task cancelled: Add reducer tests.');
  });

  it('keeps delegated work running after parent abort and wakes the agent on completion', async () => {
    const task = await seed('Add reducer tests');
    const controller = new AbortController();
    await manager.assign(task.id, { agent: 'reviewer', signal: controller.signal });
    const { requestId } = bus.lastRequest();

    controller.abort();
    await flush();

    expect(
      bus.emitted.some(
        (entry) =>
          entry.channel === SUBAGENT_DELEGATION_CANCEL_EVENT &&
          (entry.data as { requestId?: string }).requestId === requestId,
      ),
    ).toBe(false);
    expect(taskById(task.id)?.delegation?.state).toBe('requested');

    bus.emit(DOOM_DELEGATION_STARTED_EVENT, { version: 1, requestId, runId: 'run-after-abort' });
    await flush();
    bus.emit(DOOM_DELEGATION_FINISHED_EVENT, {
      version: 1,
      requestId,
      runId: 'run-after-abort',
      status: 'completed',
      output: 'finished independently',
    });
    await flush();

    expect(taskById(task.id)?.status).toBe('completed');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ customType: 'doom-task-notify' }), {
      triggerTurn: true,
      deliverAs: 'steer',
    });
  });

  it('rejects cancelling a task with no running delegation', async () => {
    const task = await seed('Add reducer tests');

    expect((await manager.cancel(task.id)).ok).toBe(false);
  });

  it('ignores responses for delegations it does not own', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });

    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId: 'someone-else', status: 'completed' });
    await flush();

    expect(taskById(task.id)?.status).toBe('pending');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('degradation when the subagents runtime is absent', () => {
  it('fails the delegation with an actionable error when nothing responds', async () => {
    const task = await seed('Add reducer tests');

    await manager.assign(task.id, { agent: 'reviewer' });
    await flush(120);

    const stored = taskById(task.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.delegation?.result?.error).toBe(ERR_NO_RUNTIME);
    expect(notify.mock.calls[0][0].content).toContain(ERR_NO_RUNTIME);
  });

  it('does not report a missing runtime after the runtime accepts a slow launch', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });

    bus.emit(SUBAGENT_DELEGATION_ACCEPTED_EVENT, { version: 1, requestId: bus.lastRequest().requestId });
    await flush(120);

    expect(taskById(task.id)?.status).toBe('pending');
    expect(taskById(task.id)?.delegation).toMatchObject({ state: 'requested' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not fire the timeout once the run has started', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });

    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId: bus.lastRequest().requestId });
    await flush(120);

    expect(taskById(task.id)?.status).toBe('in_progress');
  });
});

describe('run watchdog', () => {
  it('carries the run budget on the request so the runtime can stop itself', async () => {
    manager.dispose();
    manager = makeManager({}, { runTimeoutMs: 1234 });
    const task = await seed('Add reducer tests');

    await manager.assign(task.id, { agent: 'reviewer' });

    expect(bus.lastRequest().timeoutMs).toBe(1234);
  });

  it('fails a started run that never reports a result', async () => {
    manager.dispose();
    manager = makeManager({}, { runTimeoutMs: 40 });
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId });
    await flush(250);

    const stored = taskById(task.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.delegation?.state).toBe('failed');
    expect(stored?.delegation?.result?.status).toBe('timed_out');
    expect(manager.listActiveWork()).toEqual([]);
    expect(
      bus.emitted.some(
        (entry) =>
          entry.channel === SUBAGENT_DELEGATION_CANCEL_EVENT &&
          (entry.data as { requestId?: string }).requestId === requestId,
      ),
    ).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(report.warn).toHaveBeenCalledWith(TASK_EVENT.delegationTimedOut, expect.any(Error), expect.anything());
  });

  it('does not fire once the run reported a result', async () => {
    manager.dispose();
    manager = makeManager({}, { runTimeoutMs: 40 });
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId });
    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId, status: 'completed' });
    await flush(250);

    expect(taskById(task.id)?.status).toBe('completed');
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('settling exactly once', () => {
  it('ignores a duplicate response', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId, status: 'completed' });
    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId, status: 'failed', error: 'late' });
    await flush();

    expect(taskById(task.id)?.status).toBe('completed');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('still notifies and releases the run when the settle write fails', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();
    vi.spyOn(store, 'mutate').mockRejectedValueOnce(new Error('disk full'));

    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId, status: 'completed' });
    await flush();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(manager.listActiveWork()).toEqual([]);
    expect(report.error).toHaveBeenCalledWith(TASK_EVENT.delegationSettleFailed, expect.any(Error), expect.anything());
  });

  it('does not revive a delegation that already reached a terminal state', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();
    // A cancel that won the store lock while the started event was in flight.
    await store.mutate((document) => ({
      document: {
        ...document,
        tasks: document.tasks.map((entry) =>
          entry.id === task.id
            ? {
                ...entry,
                status: 'pending' as const,
                delegation: { ...entry.delegation!, state: 'cancelled' as const },
              }
            : entry,
        ),
      },
      value: undefined,
    }));

    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId });
    await flush();

    expect(taskById(task.id)?.delegation?.state).toBe('cancelled');
    expect(taskById(task.id)?.status).toBe('pending');
  });
});

describe('cancel fallback', () => {
  it('forces a terminal state when the runtime never acknowledges', async () => {
    manager.dispose();
    manager = makeManager({}, { cancelTimeoutMs: 40 });
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId: bus.lastRequest().requestId });
    await flush();

    narrate.mockClear();
    await manager.cancel(task.id);
    expect(narrate).not.toHaveBeenCalled();

    await flush(200);

    const stored = taskById(task.id);
    expect(stored?.status).toBe('pending');
    expect(stored?.delegation?.state).toBe('cancelled');
    expect(stored?.delegation?.result?.error).toBe(ERR_CANCEL_UNACKNOWLEDGED);
    expect(narrate).toHaveBeenCalledOnce();
    expect(narrate).toHaveBeenCalledWith('Task cancelled: Add reducer tests.');
  });

  it('prefers a real response that arrives inside the window', async () => {
    manager.dispose();
    manager = makeManager({}, { cancelTimeoutMs: 200 });
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    await manager.cancel(task.id);
    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId, status: 'cancelled' });
    await flush(300);

    expect(taskById(task.id)?.delegation?.result?.error).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('recovery across a session restart', () => {
  it('leaves a delegation this session is still tracking alone', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });

    expect(await manager.reconcile()).toEqual([]);
    expect(taskById(task.id)?.delegation?.state).toBe('requested');
  });

  it('recovers a delegation stranded by an in-process restart', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId: bus.lastRequest().requestId });
    await flush();

    // session_shutdown followed by session_start, same live pid.
    manager.dispose();
    manager = makeManager();
    const orphaned = await manager.reconcile();

    expect(orphaned).toHaveLength(1);
    expect(taskById(task.id)?.status).toBe('pending');
    expect(taskById(task.id)?.delegation?.state).toBe('failed');
    expect(report.warn).toHaveBeenCalledWith(TASK_EVENT.delegationOrphaned, expect.any(Error), expect.anything());
  });

  it('does not reconcile from a stale session callback', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    bus.emit(SUBAGENT_DELEGATION_STARTED_EVENT, { version: 1, requestId: bus.lastRequest().requestId });
    await flush();

    manager.dispose();
    manager = makeManager();

    await expect(manager.reconcile(() => false)).resolves.toEqual([]);
    expect(taskById(task.id)?.delegation?.state).toBe('running');
    expect(report.warn).not.toHaveBeenCalledWith(TASK_EVENT.delegationOrphaned, expect.anything(), expect.anything());
  });

  it('does not stack handlers when start is called again', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });

    bus.bind(manager);
    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      version: 1,
      requestId: bus.lastRequest().requestId,
      status: 'completed',
    });
    await flush();

    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('background work reporting', () => {
  it('retains the assignment session when the current session changes', async () => {
    let currentSession = 'session-1';
    manager.dispose();
    manager = makeManager({}, { getSessionId: () => currentSession });
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    currentSession = 'session-2';

    expect(manager.listActiveWork()).toEqual([{ id: `task-${task.id}:${requestId}`, sessionId: 'session-1' }]);
  });

  it('invalidates publication when work starts and after its completion handoff', async () => {
    const snapshots: Array<Array<{ id: string; sessionId: string }>> = [];
    manager.dispose();
    manager = makeManager({}, { onChange: () => snapshots.push(manager.listActiveWork()) });
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();

    expect(snapshots.at(-1)).toEqual([{ id: `task-${task.id}:${requestId}`, sessionId: 'session-1' }]);

    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId, status: 'completed' });
    await flush();

    expect(snapshots.at(-1)).toEqual([]);
  });

  it('keeps work active through the terminal store commit and model notification', async () => {
    const task = await seed('Add reducer tests');
    await manager.assign(task.id, { agent: 'reviewer' });
    const { requestId } = bus.lastRequest();
    const active = [{ id: `task-${task.id}:${requestId}`, sessionId: 'session-1' }];
    narrate.mockClear();
    narrate.mockImplementationOnce(() => expect(manager.listActiveWork()).toEqual(active));
    notify.mockImplementationOnce(() => expect(manager.listActiveWork()).toEqual(active));

    bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { version: 1, requestId, status: 'completed' });
    await flush();

    expect(narrate).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(manager.listActiveWork()).toEqual([]);
  });
});

describe('session-tree store sharing', () => {
  it('makes a child delegation update visible to the root store', async () => {
    const rootPath = resolveStorePath(directory, {}, resolveSessionKey('root-session', {}));
    const childPath = resolveStorePath(
      directory,
      {},
      resolveSessionKey('child-session', {
        PI_SUBAGENT_CHILD: '1',
        PI_SUBAGENT_PARENT_SESSION: 'root-session',
      }),
    );
    expect(childPath).toBe(rootPath);
    const parentStore = new TaskStore({ storePath: rootPath });
    const childStore = new TaskStore({ storePath: childPath });
    await parentStore.mutate((document) => {
      const result = applyTaskMutation(document, 'upsert', { tasks: [{ subject: 'shared delegation task' }] });
      return { document: result.document, value: undefined };
    });

    await childStore.mutate((document) => {
      const task = document.tasks[0];
      return {
        document: {
          ...document,
          tasks: document.tasks.map((entry) =>
            entry.id === task.id ? { ...entry, status: 'in_progress' as const } : entry,
          ),
        },
        value: undefined,
      };
    });

    expect(parentStore.read().tasks[0].status).toBe('in_progress');
    parentStore.dispose();
    childStore.dispose();
  });
});
