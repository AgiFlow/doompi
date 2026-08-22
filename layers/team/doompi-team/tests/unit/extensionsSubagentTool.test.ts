import * as fs from 'node:fs';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ManagementActionsContract,
  ListActionResult,
  StatusActionResult,
} from '../../src/adapters/pi/extensions/managementActions';
import type {
  SpawnPlannerContract,
  SpawnPlanRequest,
  SpawnPlanResult,
} from '../../src/adapters/pi/extensions/spawnPlan';
import { SUBAGENT_TOOL_NAME, SubagentToolService } from '../../src/adapters/pi/extensions/subagentTool';
import type {
  AgentConfig,
  AgentDiscoveryResult,
  AgentScope,
  AgentDiscoveryContract,
} from '../../src/adapters/agents/types';
import type { AsyncJobTrackerContract, TrackedAsyncJob } from '../../src/adapters/asyncJobTracker';
import { listSuspendedRuns, suspendRun } from '../../src/adapters/suspendedRuns';
import { createSessionScope, sessionScopeDir, setCurrentSessionScope } from '../../src/adapters/filesystem/paths';

class FakeSpawnPlanner implements SpawnPlannerContract {
  calls: SpawnPlanRequest[] = [];
  result: SpawnPlanResult = { outcomes: [] };
  async spawn(request: SpawnPlanRequest): Promise<SpawnPlanResult> {
    this.calls.push(request);
    return this.result;
  }
}

class FakeManagement implements ManagementActionsContract {
  stopCalls: Array<{ id: string; reason?: string }> = [];
  steerCalls: Array<{ id: string; message: string; targetIndex?: number }> = [];
  statusResult: StatusActionResult = {
    runId: 'run-1',
    runDir: '/run-1',
    claimed: false,
    status: undefined,
  };
  status(): StatusActionResult {
    return this.statusResult;
  }
  list(): ListActionResult {
    return { runs: [] };
  }
  interrupt() {
    return { requestPath: '/interrupt' };
  }
  stop(id: string, reason?: string) {
    this.stopCalls.push({ id, reason });
    return { requestPath: '/stop' };
  }
  async steer(id: string, message: string, targetIndex?: number) {
    this.steerCalls.push({ id, message, targetIndex });
    return { requestPath: '/steer', requestId: 'steer-1', index: 0, state: 'delivered' as const, message: 'accepted' };
  }
}

class FakeTracker implements AsyncJobTrackerContract {
  tracked: string[] = [];
  runtime = 'pi';
  forSession() {
    return this;
  }
  track(runId: string): void {
    this.tracked.push(runId);
  }
  untrack(): void {}
  list(): TrackedAsyncJob[] {
    return [{ runId: 'run-1', status: 'running', runtime: this.runtime }];
  }
  get(id: string): TrackedAsyncJob | undefined {
    return id === 'run-1' ? { runId: id, status: 'running', runtime: this.runtime } : undefined;
  }
  reset(): void {}
  start(): void {}
  stop(): void {}
}

const worker: AgentConfig = {
  name: 'worker',
  description: 'Focused worker',
  source: 'project',
  filePath: '/work/worker.md',
  systemPrompt: 'Work.',
  systemPromptMode: 'replace',
  inheritProjectContext: true,
  inheritSkills: false,
  tools: ['read'],
};

class FakeDiscovery implements AgentDiscoveryContract {
  discover(_cwd: string, _scope: AgentScope): AgentDiscoveryResult {
    return { agents: [worker], projectAgentsDir: '/work/.pi/agents' };
  }
  find(_cwd: string, _scope: AgentScope, name: string): AgentConfig | undefined {
    return name === worker.name ? worker : undefined;
  }
  invalidate(): void {}
}

function host(existing: ToolDefinition[] = []): { pi: ExtensionAPI; tools: ToolDefinition[] } {
  const tools = [...existing];
  return {
    tools,
    pi: {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      getAllTools: () => tools,
    } as unknown as ExtensionAPI,
  };
}

function context(model?: { provider: string; id: string }): ExtensionContext {
  return {
    cwd: '/work',
    sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => undefined },
    modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false },
    ...(model ? { model } : {}),
  } as unknown as ExtensionContext;
}

let toolCallSequence = 0;

function harness() {
  const planner = new FakeSpawnPlanner();
  const management = new FakeManagement();
  const tracker = new FakeTracker();
  const discovery = new FakeDiscovery();
  const service = new SubagentToolService(planner, management, tracker, discovery);
  const registered = host();
  service.registerTool(registered.pi);
  const tool = registered.tools[0]!;
  const call = async (
    params: Record<string, unknown>,
    onUpdate?: Parameters<typeof tool.execute>[3],
    ctx: ExtensionContext = context(),
  ) => tool.execute(`call-${++toolCallSequence}`, params, new AbortController().signal, onUpdate, ctx);
  return { planner, management, tracker, service, registered, call };
}

describe('SubagentToolService registration', () => {
  it('registers exactly one subagent tool and is idempotent per host', () => {
    const h = harness();
    h.service.registerTool(h.registered.pi);
    expect(h.registered.tools.map((tool) => tool.name)).toEqual([SUBAGENT_TOOL_NAME]);
  });

  it('owns its render shell and provides both custom renderer slots', () => {
    const tool = harness().registered.tools[0];

    expect(tool?.renderShell).toBe('self');
    expect(tool?.renderCall).toBeTypeOf('function');
    expect(tool?.renderResult).toBeTypeOf('function');
  });

  it('fails loudly on a foreign tool collision', () => {
    const h = harness();
    const foreign = host([{ name: 'subagent' } as ToolDefinition]);
    expect(() => h.service.registerTool(foreign.pi)).toThrow(/\[tool_conflict\]/);
  });
});

describe('SubagentToolService actions', () => {
  it('emits progress for long-running actions', async () => {
    const h = harness();
    h.planner.result = { outcomes: [{ agent: 'worker', task: 'do it', childIndex: 0, runId: 'run-new' }] };
    const onUpdate = vi.fn();

    await h.call({ action: 'run', requests: [{ agent: 'worker', task: 'do it' }] }, onUpdate);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ content: [{ type: 'text', text: 'Starting 1 subagent...' }] }),
    );
  });

  it('returns failed launch reasons with one conditional recovery path', async () => {
    const h = harness();
    h.planner.result = { outcomes: [{ agent: 'worker', task: 'do it', childIndex: 0, error: 'runtime missing' }] };

    const message = await h.call({ action: 'run', requests: [{ agent: 'worker', task: 'do it' }] }).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toBe(
      '[runtime_unavailable] No requested subagent started.\n- worker: failed: runtime missing\nRecovery: Correct the reported launch failures. If an agent name is uncertain, call subagent({"action":"agents"}) before retrying only corrected requests.',
    );
    expect(message).not.toContain('ask the user');
  });

  it('steers away from retrying a partially successful spawn request', async () => {
    const h = harness();
    h.planner.result = {
      outcomes: [
        { agent: 'worker', task: 'first', childIndex: 0, runId: 'run-new' },
        { agent: 'worker', task: 'second', childIndex: 1, error: 'workspace busy' },
      ],
    };

    const result = await h.call({
      action: 'run',
      requests: [
        { agent: 'worker', task: 'first' },
        { agent: 'worker', task: 'second' },
      ],
    });

    expect(result.content[0]).toEqual({
      type: 'text',
      text: [
        'Started 1/2 subagents; 1 failed:',
        '- worker: run-new',
        '- worker: failed: workspace busy',
        '',
        'Completion will arrive asynchronously for started runs. Do not resubmit them; retry only corrected failed entries.',
      ].join('\n'),
    });
  });

  it('runs one canonical request array and tracks started ids', async () => {
    const h = harness();
    h.planner.result = { outcomes: [{ agent: 'worker', task: 'do it', childIndex: 0, runId: 'run-new' }] };
    const result = await h.call({
      action: 'run',
      requests: [{ agent: 'worker', task: 'do it', runtime: 'pi' }],
    });
    expect(h.planner.calls[0]).toMatchObject({
      tasks: [{ agent: 'worker', task: 'do it', runtime: 'pi' }],
      cwd: '/work',
      agentScope: 'both',
    });
    expect(h.tracker.tracked).toEqual(['run-new']);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: [
        'Started 1 subagent:',
        '- worker: run-new',
        '',
        'Completion will arrive asynchronously. Continue only non-overlapping work, or end your turn.',
      ].join('\n'),
    });
  });

  it('forwards the normalized live parent model with the authenticated snapshot', async () => {
    const h = harness();
    h.planner.result = { outcomes: [{ agent: 'worker', task: 'inspect', childIndex: 0, runId: 'run-parent' }] };

    await h.call(
      { action: 'run', requests: [{ agent: 'worker', task: 'inspect' }] },
      undefined,
      context({ provider: 'openai-codex', id: 'gpt-5.6-luna' }),
    );

    expect(h.planner.calls[0]).toMatchObject({
      availableModels: [],
      parentModel: { provider: 'openai-codex', id: 'gpt-5.6-luna' },
    });
  });

  it('captures the tool-safe parent branch for agent-default forks', async () => {
    const h = harness();
    h.planner.result = { outcomes: [{ agent: 'worker', task: 'inspect', childIndex: 0, runId: 'run-fork' }] };
    const sessionFile = `/tmp/doom-team-parent-${Math.random().toString(36).slice(2)}.jsonl`;
    fs.writeFileSync(sessionFile, '{}\n');
    const ctx = {
      ...context(),
      sessionManager: {
        getSessionId: () => 'parent-session',
        getSessionFile: () => sessionFile,
        getLeafId: () => 'assistant-leaf',
        getLeafEntry: () => ({
          type: 'message',
          id: 'assistant-leaf',
          parentId: 'safe-user-leaf',
          message: { role: 'assistant', content: [] },
        }),
      },
    } as unknown as ExtensionContext;

    try {
      await h.call({ action: 'run', requests: [{ agent: 'worker', task: 'inspect' }] }, undefined, ctx);
    } finally {
      fs.rmSync(sessionFile, { force: true });
    }

    expect(h.planner.calls[0]).toMatchObject({
      parentSessionId: 'parent-session',
      parentSessionFile: sessionFile,
      parentLeafId: 'safe-user-leaf',
    });
  });

  it('passes a one-shot inline agent to the spawn planner', async () => {
    const h = harness();
    h.planner.result = {
      outcomes: [{ agent: 'schema-explorer', task: 'inspect', childIndex: 0, runId: 'run-inline' }],
    };

    await h.call({
      action: 'run',
      requests: [
        {
          agent: 'schema-explorer',
          inlineAgent: { systemPrompt: 'Inspect schemas only.' },
          task: 'inspect',
        },
      ],
    });

    expect(h.planner.calls[0]).toMatchObject({
      tasks: [
        {
          agent: 'schema-explorer',
          inlineAgent: { systemPrompt: 'Inspect schemas only.' },
          task: 'inspect',
        },
      ],
    });
  });

  it('replays one tool call id without spawning duplicate runs', async () => {
    const h = harness();
    h.planner.result = { outcomes: [{ agent: 'worker', task: 'do it', childIndex: 0, runId: 'run-new' }] };
    const tool = h.registered.tools[0]!;
    const params = { action: 'run', requests: [{ agent: 'worker', task: 'do it' }] };
    const operationId = `replay-${++toolCallSequence}`;

    const first = await tool.execute(operationId, params, undefined, undefined, context());
    const replay = await tool.execute(operationId, params, undefined, undefined, context());

    expect(replay).toEqual(first);
    expect(h.planner.calls).toHaveLength(1);
  });

  it('rejects legacy and unknown fields at the runtime boundary', async () => {
    const h = harness();
    await expect(h.call({ agent: 'worker', task: 'old shape' })).rejects.toThrow(/\[invalid_request\]/);
    await expect(
      h.call({ action: 'run', requests: [{ agent: 'worker', task: 'x' }], context: 'fork' }),
    ).rejects.toThrow(/does not accept: context/);
    await expect(
      h.call({ action: 'run', requests: [{ agent: 'worker', task: 'x' }], model: 'legacy/top-level' }),
    ).rejects.toThrow(/does not accept: model/);
    await expect(h.call({ action: 'agents', model: 42 })).rejects.toThrow(/does not accept: model/);
  });

  it('tolerates the legacy string model only on recognized non-run actions', async () => {
    const h = harness();
    const result = await h.call({ action: 'agents', model: 'legacy/planning-model' });

    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('worker') });
  });

  it('lists agents and returns concise details without the system prompt', async () => {
    const h = harness();
    const list = await h.call({ action: 'agents' });
    const detail = await h.call({ action: 'agents', name: 'worker' });
    expect(list.content[0]).toMatchObject({ text: expect.stringContaining('worker') });
    expect(detail.content[0]).toMatchObject({ text: expect.not.stringContaining('System Prompt') });
    expect(detail.details).not.toHaveProperty('agent.systemPrompt');
  });

  it('returns fleet status without an id and rejects transcript lines without an id', async () => {
    const h = harness();
    const result = await h.call({ action: 'status' });
    expect(result.details).toHaveProperty('fleet');
    await expect(h.call({ action: 'status', transcriptLines: 10 })).rejects.toThrow(/requires a run id/);
  });

  it('rejects the removed wait action', async () => {
    const h = harness();
    await expect(h.call({ action: 'wait', ids: ['run-1'], until: 'completion', timeoutMs: 10 })).rejects.toThrow(
      /Unsupported or missing subagent action "wait"/,
    );
  });

  it('derives steering target internally and rejects missing messages', async () => {
    const h = harness();
    await h.call({ action: 'steer', id: 'run-1', message: 'continue' });
    expect(h.management.steerCalls).toEqual([{ id: 'run-1', message: 'continue', targetIndex: undefined }]);
    await expect(h.call({ action: 'steer', id: 'run-1' })).rejects.toThrow(/requires nonblank 'message'/);
  });

  it('rejects steering for external runtimes', async () => {
    const h = harness();
    h.tracker.runtime = 'claude';
    await expect(h.call({ action: 'steer', id: 'run-1', message: 'continue' })).rejects.toThrow(
      /\[unsupported_operation\]/,
    );
  });

  it('forwards stop reasons', async () => {
    const h = harness();
    await h.call({ action: 'stop', id: 'run-1', reason: 'no longer needed' });
    expect(h.management.stopCalls).toEqual([{ id: 'run-1', reason: 'no longer needed' }]);
  });
});

describe('SubagentToolService restore safety', () => {
  const scope = createSessionScope(`subagent-tool-${Math.random().toString(36).slice(2)}`);

  afterEach(() => {
    fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
    setCurrentSessionScope(scope);
  });

  it('refuses to restart suspended work without a Pi transcript', async () => {
    setCurrentSessionScope(scope);
    suspendRun(scope, {
      runId: 'external-run',
      agent: 'worker',
      runtime: 'claude',
      task: 'side effect',
      cwd: '/work',
      suspendedAt: 1,
      reason: 'quit',
    });
    await expect(harness().call({ action: 'restore', id: 'external-run' })).rejects.toThrow(/\[not_resumable\]/);
    expect(listSuspendedRuns(scope)).toHaveLength(1);
  });

  it('includes suspended work in normal fleet status and status-by-id', async () => {
    setCurrentSessionScope(scope);
    suspendRun(scope, {
      runId: 'suspended-run',
      agent: 'worker',
      runtime: 'pi',
      task: 'continue the audit',
      cwd: '/work',
      suspendedAt: 1,
      reason: 'resume',
    });
    const h = harness();

    const fleet = await h.call({ action: 'status' });
    const detail = await h.call({ action: 'status', id: 'suspended-run' });

    expect(fleet.details).toHaveProperty('suspended.0.runId', 'suspended-run');
    expect(fleet.content[0]).toMatchObject({ text: expect.stringContaining('suspended-run') });
    expect(detail.content[0]).toMatchObject({ text: expect.stringContaining("Run 'suspended-run' is suspended") });
  });

  it('restores named and inline Pi recovery metadata and clears the old record only after startup', async () => {
    setCurrentSessionScope(scope);
    fs.mkdirSync(sessionScopeDir(scope), { recursive: true });
    const sessionFile = `${sessionScopeDir(scope)}/child.jsonl`;
    fs.writeFileSync(sessionFile, '');
    suspendRun(scope, {
      runId: 'inline-run',
      agent: 'inline-explorer',
      inlineAgent: { systemPrompt: 'Inspect schemas only.' },
      runtime: 'pi',
      task: 'continue the audit',
      cwd: '/work',
      model: 'openai-codex/gpt-5.6-sol',
      sessionFile,
      suspendedAt: 1,
      reason: 'resume',
    });
    const h = harness();
    h.planner.result = {
      outcomes: [{ agent: 'inline-explorer', task: 'continue the audit', childIndex: 0, runId: 'restored-run' }],
    };

    const result = await h.call({ action: 'restore', id: 'inline-run' });

    expect(h.planner.calls[0]).toMatchObject({
      single: {
        agent: 'inline-explorer',
        inlineAgent: { systemPrompt: 'Inspect schemas only.' },
        task: 'continue the audit',
        cwd: '/work',
        model: 'openai-codex/gpt-5.6-sol',
        sessionFile,
      },
      runtime: 'pi',
    });
    expect(result.details).toHaveProperty('restore.restoredFrom', 'inline-run');
    expect(h.tracker.tracked).toContain('restored-run');
    expect(listSuspendedRuns(scope)).toEqual([]);
  });

  it('retains a resumable record when restored startup fails', async () => {
    setCurrentSessionScope(scope);
    fs.mkdirSync(sessionScopeDir(scope), { recursive: true });
    const sessionFile = `${sessionScopeDir(scope)}/failed-child.jsonl`;
    fs.writeFileSync(sessionFile, '');
    suspendRun(scope, {
      runId: 'failed-restore',
      agent: 'worker',
      runtime: 'pi',
      task: 'continue',
      cwd: '/work',
      sessionFile,
      suspendedAt: 1,
      reason: 'resume',
    });
    const h = harness();
    h.planner.result = { outcomes: [{ agent: 'worker', task: 'continue', childIndex: 0, error: 'boot failed' }] };

    await expect(h.call({ action: 'restore', id: 'failed-restore' })).rejects.toThrow(/boot failed/);

    expect(listSuspendedRuns(scope).map((run) => run.runId)).toEqual(['failed-restore']);
  });
});
