import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationManager } from '../src/exports/delegation/manager';
import { TaskStore } from '../src/exports/store/taskStore';
import { TaskAssignmentSchema, TaskParamsSchema } from '../src/exports/tool/schema';
import { DEFAULT_PROMPT_GUIDELINES, registerTaskTool } from '../src/exports/tool/taskTool';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-task-tool-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function harness(outcome = { ok: false, message: '#1 is blocked by #2' }, maxTasks?: number) {
  const store = new TaskStore({ storePath: path.join(directory, 'tasks.json') });
  store.read();
  const delegation = {
    assign: vi.fn().mockResolvedValue(outcome),
    cancel: vi.fn().mockResolvedValue(outcome),
  } as unknown as DelegationManager;
  let tool: ToolDefinition | undefined;
  registerTaskTool(
    {
      registerTool: (registered: ToolDefinition) => {
        tool = registered;
      },
    } as unknown as ExtensionAPI,
    { store, delegation, ...(maxTasks === undefined ? {} : { maxTasks }) },
  );
  if (!tool) throw new Error('Task tool was not registered.');
  return { store, delegation, tool };
}

/** Concatenated result text, which is the only channel the model reads. */
function text(result: { content: readonly unknown[] }): string {
  return result.content.map((block) => (block as { text?: string }).text ?? '').join('');
}

function run(tool: ToolDefinition, params: Record<string, unknown>) {
  return tool.execute('call-1', params, undefined, undefined, {} as never);
}

describe('task upsert boundary', () => {
  it('returns a bare single-entry line rather than a bulk report', async () => {
    const { tool } = harness();

    const result = await run(tool, { action: 'upsert', tasks: [{ subject: 'brand new' }] });

    expect(text(result)).toBe('Created #1: brand new (pending)');
  });

  it('commits the entries that pass and reports the failures without throwing', async () => {
    const { tool, store } = harness();

    const result = await run(tool, {
      action: 'upsert',
      tasks: [{ subject: 'a' }, { id: 99, status: 'completed' }, { subject: 'b' }],
    });

    const rendered = text(result);
    expect(rendered).toContain('Upsert applied 2/3 entries; 1 failed.');
    expect(rendered).toContain('- [1] Failed #99: #99 not found');
    expect(rendered).toContain('Resend only the failed entries, corrected');
    expect(store.read().tasks.map((task) => task.subject)).toEqual(['a', 'b']);
  });

  it('does not mark a partial batch as an error, so the applied rows still render', async () => {
    const { tool } = harness();

    const result = await run(tool, { action: 'upsert', tasks: [{ subject: 'a' }, { id: 99 }] });

    expect((result.details as { error?: string }).error).toBeUndefined();
    expect((result.details as { upsert?: unknown }).upsert).toEqual({ applied: [1], failed: 1 });
  });

  it('throws and writes nothing when every entry fails', async () => {
    const { tool, store } = harness();
    await run(tool, { action: 'upsert', tasks: [{ subject: 'seed' }] });
    const revBefore = store.read().rev;

    await expect(run(tool, { action: 'upsert', tasks: [{ id: 98 }, { id: 99 }] })).rejects.toThrow(
      /Task upsert failed: no entry was applied[\s\S]*- \[1\] Failed #99[\s\S]*Options:/,
    );
    expect(store.read().rev).toBe(revBefore);
  });

  it('reports the committed rev rather than the pre-write one', async () => {
    const { tool } = harness();

    const result = await run(tool, { action: 'upsert', tasks: [{ subject: 'a' }] });

    expect((result.details as { rev: number }).rev).toBe(1);
  });

  it('rejects a top-level id instead of silently creating a duplicate', async () => {
    const { tool } = harness();

    await expect(run(tool, { action: 'upsert', id: 3, tasks: [{ status: 'completed' }] })).rejects.toThrow(
      /upsert does not accept id[\s\S]*Per-task fields belong inside each tasks\[\] entry/,
    );
  });

  it('rejects a field that belongs to a different action', async () => {
    const { tool } = harness();

    await expect(run(tool, { action: 'list', agent: 'reviewer' })).rejects.toThrow(/list does not accept agent/);
  });

  it('rejects an upsert with no tasks array', async () => {
    const { tool } = harness();

    await expect(run(tool, { action: 'upsert' })).rejects.toThrow(/requires a non-empty tasks array/);
  });

  it('raises an actionable error when a new task exceeds the configured board limit', async () => {
    const { tool, store } = harness(undefined, 2);
    await run(tool, { action: 'upsert', tasks: [{ subject: 'first' }, { subject: 'second' }] });

    await expect(run(tool, { action: 'upsert', tasks: [{ subject: 'third' }] })).rejects.toThrow(
      /task limit of 2 reached; delete completed tasks first/,
    );
    expect(store.read().tasks).toHaveLength(2);
  });
});

describe('task Pi tool boundary', () => {
  it('exposes assign-time fields only inside assignments[]', () => {
    expect(TaskParamsSchema.properties).not.toHaveProperty('agent');
    expect(TaskParamsSchema.properties).not.toHaveProperty('model');
    expect(TaskAssignmentSchema.properties).toHaveProperty('agent');
    expect(TaskAssignmentSchema.properties).toHaveProperty('model');
  });

  it('keeps task-use policy in the tool description instead of system prompt metadata', () => {
    const { tool } = harness();
    const guidelines = DEFAULT_PROMPT_GUIDELINES.join('\n');

    expect(tool.description).toContain('Do not use it for simple requests');
    expect(tool.promptSnippet).toBeUndefined();
    expect(tool.promptGuidelines).toEqual(DEFAULT_PROMPT_GUIDELINES);
    expect(guidelines).toContain('Capture a whole plan in one call');
    expect(guidelines).not.toContain('Use `task` only for complex jobs');
    expect(guidelines).not.toContain('3+ steps');
  });

  it('owns its render shell instead of using Pi status backgrounds', () => {
    const { tool } = harness();

    expect(tool.renderShell).toBe('self');
  });

  it('turns reducer failures into actionable Pi errors', async () => {
    const { tool } = harness();

    await expect(tool.execute('get-1', { action: 'get', id: 99 }, undefined, undefined, {} as never)).rejects.toThrow(
      /Task get failed: #99 not found[\s\S]*Options:[\s\S]*List the task board/,
    );
  });

  it('reports delegation progress and rejects unsuccessful outcomes', async () => {
    const { tool } = harness();
    const onUpdate = vi.fn();

    await expect(
      tool.execute(
        'assign-1',
        { action: 'assign', assignments: [{ id: 1, agent: 'reviewer' }] },
        undefined,
        onUpdate,
        {} as never,
      ),
    ).rejects.toThrow(/Task assign failed: #1 is blocked by #2[\s\S]*Options:/);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ content: [{ type: 'text', text: 'Delegating task #1...' }] }),
    );
  });

  it('forwards the assign-time context pack to the delegation manager', async () => {
    const { tool, delegation } = harness({ ok: true, message: 'Delegated #1 to worker' });

    await tool.execute(
      'assign-2',
      {
        action: 'assign',
        assignments: [
          {
            id: 1,
            agent: 'worker',
            relevantFiles: ['src/a.ts'],
            priorFindings: 'the parser lives in a.ts',
          },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(delegation.assign).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ relevantFiles: ['src/a.ts'], priorFindings: 'the parser lives in a.ts' }),
    );
  });

  it('batches independent assignments in one indexed result', async () => {
    const { tool, delegation } = harness({ ok: true, message: 'delegated' });
    const assign = vi.mocked(delegation.assign);
    assign
      .mockResolvedValueOnce({ ok: true, message: 'first started' })
      .mockResolvedValueOnce({ ok: false, message: '#2 is blocked by #4' })
      .mockResolvedValueOnce({ ok: true, message: 'third started' });
    const onUpdate = vi.fn();

    const result = await tool.execute(
      'assign-batch',
      {
        action: 'assign',
        assignments: [
          {
            id: 1,
            agent: 'architect',
            relevantFiles: ['src/index.ts'],
            model: 'openai-codex/child:high',
          },
          { id: 2, agent: 'reviewer' },
          { id: 3, agent: 'experience' },
        ],
      },
      undefined,
      onUpdate,
      {} as never,
    );

    expect(text(result)).toBe(
      [
        'Assigned 2/3 tasks; 1 failed.',
        '- [0] Delegated #1 to architect',
        '- [1] Failed #2 → reviewer: #2 is blocked by #4',
        '- [2] Delegated #3 to experience',
        '',
        'Successful assignments are already running. Retry only the failed entries after correcting their task state or arguments; do not resend successful entries.',
      ].join('\n'),
    );
    expect((result.details as { assignment?: unknown }).assignment).toEqual({ assigned: [1, 3], failed: 1 });
    expect(assign).toHaveBeenCalledTimes(3);
    expect(assign).toHaveBeenNthCalledWith(
      1,
      1,
      expect.objectContaining({
        agent: 'architect',
        relevantFiles: ['src/index.ts'],
        model: 'openai-codex/child:high',
      }),
    );
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ content: [{ type: 'text', text: 'Delegating 3 tasks...' }] }),
    );
  });

  it('throws when no entry in an assignment batch starts', async () => {
    const { tool, delegation } = harness();

    await expect(
      run(tool, {
        action: 'assign',
        assignments: [
          { id: 1, agent: 'architect' },
          { id: 2, agent: 'reviewer' },
        ],
      }),
    ).rejects.toThrow(/Task assign failed: Assigned 0\/2 tasks; 2 failed[\s\S]*Failed #2 → reviewer/);
    expect(delegation.assign).toHaveBeenCalledTimes(2);
  });

  it('keeps a partial batch result when one delegation call throws unexpectedly', async () => {
    const { tool, delegation } = harness({ ok: true, message: 'delegated' });
    vi.mocked(delegation.assign)
      .mockResolvedValueOnce({ ok: true, message: 'first started' })
      .mockRejectedValueOnce(new Error('store unavailable'));

    const result = await run(tool, {
      action: 'assign',
      assignments: [
        { id: 1, agent: 'architect' },
        { id: 2, agent: 'reviewer' },
      ],
    });

    expect(text(result)).toContain('Assigned 1/2 tasks; 1 failed.');
    expect(text(result)).toContain('Failed #2 → reviewer: store unavailable');
    expect(text(result)).toContain('do not resend successful entries');
  });

  it('rejects the removed top-level single-assignment form', async () => {
    const { tool, delegation } = harness();

    await expect(
      run(tool, { action: 'assign', id: 1, agent: 'architect', model: 'openai-codex/child:high' }),
    ).rejects.toThrow(/assign does not accept id, agent, model/);
    expect(delegation.assign).not.toHaveBeenCalled();
  });

  it('requires a non-empty assignments batch', async () => {
    const { tool, delegation } = harness();

    await expect(run(tool, { action: 'assign' })).rejects.toThrow(/assign requires a non-empty assignments\[\]/);
    expect(delegation.assign).not.toHaveBeenCalled();
  });

  it('rejects the context pack on an action that does not delegate', async () => {
    const { tool } = harness();

    await expect(run(tool, { action: 'list', relevantFiles: ['src/a.ts'] })).rejects.toThrow(
      /list does not accept relevantFiles/,
    );
  });

  it('returns a successful cancellation and emits its initial update', async () => {
    const { tool } = harness({ ok: true, message: 'Cancelling delegation for #1' });
    const onUpdate = vi.fn();

    const result = await tool.execute('cancel-1', { action: 'cancel', id: 1 }, undefined, onUpdate, {} as never);

    expect(result.content[0]).toEqual({ type: 'text', text: 'Cancelling delegation for #1' });
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ content: [{ type: 'text', text: 'Requesting cancellation for task #1...' }] }),
    );
  });
});
