import { describe, expect, it, vi } from 'vitest';
import { registerRunWorktreeTool } from '../../../../src/adapters/pi/extensions/runWorktreeTool.ts';
import type { WorktreeOperations } from '../../../../src/adapters/worktree/worktreeOperations.ts';
import type { WorktreeRecord } from '../../../../src/types/worktreeRegistry.ts';

const RECORD: WorktreeRecord = {
  version: 1,
  id: 'a1b2c3d4',
  branch: 'wt/one',
  baseRef: 'main',
  path: '/tmp/worktrees/wt-one--a1b2c3d4',
  repositoryRoot: '/repo',
  sessionId: 'session-9',
  parentSessionId: 'parent-1',
  status: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function operations(overrides: Partial<WorktreeOperations> = {}): WorktreeOperations {
  return {
    spawn: vi.fn().mockResolvedValue(RECORD),
    close: vi.fn().mockResolvedValue(RECORD),
    list: vi.fn().mockResolvedValue([RECORD]),
    status: vi.fn().mockResolvedValue({ record: RECORD, dirtyFiles: [] }),
    merge: vi.fn().mockResolvedValue(RECORD),
    prune: vi.fn().mockResolvedValue({ remove: [], forget: [], untracked: [], keptDirty: [] }),
    send: vi.fn().mockResolvedValue(undefined),
    messages: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** Captures the tool the extension registers, so execute can be driven directly. */
function toolFor(ops: WorktreeOperations) {
  let captured: { execute: (...args: never[]) => unknown } | undefined;
  const pi = {
    registerTool: (definition: unknown) => {
      captured = definition as { execute: (...args: never[]) => unknown };
    },
  };
  registerRunWorktreeTool(pi as never, ops);
  if (captured === undefined) throw new Error('no tool registered');
  return captured;
}

const CTX = { cwd: '/repo', sessionManager: { getSessionId: () => 'parent-1' } };

async function call(ops: WorktreeOperations, params: unknown): Promise<string> {
  const tool = toolFor(ops);
  const result = (await (tool.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
    'id',
    params,
    undefined,
    undefined,
    CTX,
  )) as { content: { text: string }[] };
  return result.content.map((block) => block.text).join('\n');
}

describe('execute', () => {
  it('registers one tool named run_worktree', () => {
    const pi = { registerTool: vi.fn() };
    registerRunWorktreeTool(pi as never, operations());
    expect(pi.registerTool).toHaveBeenCalledOnce();
    const [[definition]] = pi.registerTool.mock.calls as [[{ name: string }]];
    expect(definition.name).toBe('run_worktree');
  });

  it('spawns and reports the path and session', async () => {
    const ops = operations();
    const content = await call(ops, { action: 'spawn_worktree', branch: 'wt/one' });

    expect(ops.spawn).toHaveBeenCalledWith({ cwd: '/repo', sessionId: 'parent-1' }, { branch: 'wt/one' });
    expect(content).toContain('a1b2c3d4');
    expect(content).toContain(RECORD.path);
    expect(content).toContain('session-9');
  });

  it('passes an explicit baseRef and name through', async () => {
    const ops = operations();
    await call(ops, { action: 'spawn_worktree', branch: 'wt/one', baseRef: 'v1', name: 'Auth' });
    expect(ops.spawn).toHaveBeenCalledWith(expect.anything(), {
      branch: 'wt/one',
      baseRef: 'v1',
      name: 'Auth',
    });
  });

  // force must never be implicit: the default has to reach the operation as
  // false, or a plain close would discard work.
  it('closes without force by default', async () => {
    const ops = operations();
    await call(ops, { action: 'close_worktree', id: 'a1b2c3d4' });
    expect(ops.close).toHaveBeenCalledWith(expect.anything(), 'a1b2c3d4', false);
  });

  it('closes with force when asked', async () => {
    const ops = operations();
    await call(ops, { action: 'close_worktree', id: 'a1b2c3d4', force: true });
    expect(ops.close).toHaveBeenCalledWith(expect.anything(), 'a1b2c3d4', true);
  });

  it('lists worktrees', async () => {
    expect(await call(operations(), { action: 'list' })).toContain('wt/one');
  });

  it('says so plainly when there are none', async () => {
    const content = await call(operations({ list: vi.fn().mockResolvedValue([]) }), { action: 'list' });
    expect(content).toBe('No worktrees for this repository.');
  });

  it('reports a clean worktree as clean', async () => {
    expect(await call(operations(), { action: 'status', id: 'a1b2c3d4' })).toContain('Clean.');
  });

  it('names the dirty files in status', async () => {
    const ops = operations({
      status: vi.fn().mockResolvedValue({ record: RECORD, dirtyFiles: ['src/a.ts', 'src/b.ts'] }),
    });
    const content = await call(ops, { action: 'status', id: 'a1b2c3d4' });
    expect(content).toContain('src/a.ts, src/b.ts');
  });

  it('merges', async () => {
    const ops = operations();
    const content = await call(ops, { action: 'merge', id: 'a1b2c3d4', message: 'ship' });
    expect(ops.merge).toHaveBeenCalledWith(expect.anything(), 'a1b2c3d4', 'ship');
    expect(content).toContain('Merged wt/one');
  });

  it('says a dry-run prune changed nothing', async () => {
    const ops = operations();
    const content = await call(ops, { action: 'prune', dryRun: true });
    expect(ops.prune).toHaveBeenCalledWith(expect.anything(), true);
    expect(content).toContain('nothing was changed');
  });

  it('reports what a prune kept for holding work', async () => {
    const ops = operations({
      prune: vi.fn().mockResolvedValue({ remove: [], forget: [], untracked: [], keptDirty: [RECORD] }),
    });
    const content = await call(ops, { action: 'prune' });
    expect(content).toContain('Kept, uncommitted work: a1b2c3d4');
  });

  it('sends a message', async () => {
    const ops = operations();
    const content = await call(ops, { action: 'send', id: 'a1b2c3d4', message: 'go' });
    expect(ops.send).toHaveBeenCalledWith(expect.anything(), 'a1b2c3d4', 'go');
    expect(content).toContain('Message sent');
  });

  it('reads messages, and says so when there are none', async () => {
    expect(await call(operations(), { action: 'messages', id: 'a1b2c3d4' })).toBe('No messages.');
  });

  it('renders each waiting message with its sender', async () => {
    const ops = operations({
      messages: vi.fn().mockResolvedValue([{ version: 1, from: 'child', text: 'done', sentAt: 'T' }]),
    });
    expect(await call(ops, { action: 'messages', id: 'a1b2c3d4' })).toContain('child: done');
  });

  it('rejects an invalid call before touching any operation', async () => {
    const ops = operations();
    await expect(call(ops, { action: 'close_worktree' })).rejects.toThrow(/requires 'id'/u);
    expect(ops.close).not.toHaveBeenCalled();
  });
});
