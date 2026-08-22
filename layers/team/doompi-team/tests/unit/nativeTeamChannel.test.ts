import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readActiveTeamSnapshot } from '../../src/exports/api/teamSnapshot';
import {
  SUBAGENT_TEAM_ID_ENV,
  SUBAGENT_TEAM_MAIN_MEMBER_ENV,
  SUBAGENT_TEAM_MEMBER_ID_ENV,
  SUBAGENT_TEAM_MEMBER_TOKEN_ENV,
  SUBAGENT_TEAM_ROOT_SESSION_ENV,
} from '../../src/exports/env';
import {
  applyNativeTeamRootEnvironment,
  clearNativeTeamMemberEnvironment,
  clearNativeTeamRootEnvironment,
  ensureNativeTeamRoot,
  NATIVE_TEAM_TOOL_NAME,
  NativeTeamChannelService,
  type NativeTeamRuntime,
  nativeTeamMemberEnvironment,
  nativeTeamRootEnvironment,
  normalizeTeamMemberName,
  type PendingTeamAsk,
  pendingAsksAddressedTo,
  readMember,
  readNativeTeamMemberFromEnvironment,
  readNativeTeamRootFromEnvironment,
  registerNativeTeamMember,
  type TeamMemberContext,
  type TeamRootContext,
  teamDir,
} from '../../src/adapters/intercom/nativeTeamChannel';

function inboxDirFor(teamId: string, memberId: string): string {
  return path.join(teamDir(teamId), 'inboxes', memberId);
}

const ENV_KEYS = [
  SUBAGENT_TEAM_ID_ENV,
  SUBAGENT_TEAM_ROOT_SESSION_ENV,
  SUBAGENT_TEAM_MAIN_MEMBER_ENV,
  SUBAGENT_TEAM_MEMBER_ID_ENV,
  SUBAGENT_TEAM_MEMBER_TOKEN_ENV,
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const createdTeamIds: string[] = [];

function freshSessionId(label: string): string {
  return `session-${label}-${Math.random().toString(36).slice(2)}`;
}

function newRoot(label: string): TeamRootContext {
  const root = ensureNativeTeamRoot(freshSessionId(label));
  createdTeamIds.push(root.teamId);
  return root;
}

afterEach(() => {
  restoreEnv();
  vi.useRealTimers();
  while (createdTeamIds.length > 0) {
    const teamId = createdTeamIds.pop();
    if (teamId) fs.rmSync(teamDir(teamId), { recursive: true, force: true });
  }
});

// ============================================================================
// Member names
// ============================================================================

describe('normalizeTeamMemberName', () => {
  it('lowercases and trims a hand-written label', () => {
    expect(normalizeTeamMemberName('  Reviewer Bot  ')).toBe('reviewer-bot');
  });

  it('replaces unsafe characters with a separator', () => {
    expect(normalizeTeamMemberName('a/b@c!d')).toBe('a-b-c-d');
  });

  it('strips leading and trailing separators left after replacement', () => {
    expect(normalizeTeamMemberName('--weird..name--')).toBe('weird..name');
  });

  it('truncates to 48 characters', () => {
    const long = 'x'.repeat(80);
    const normalized = normalizeTeamMemberName(long);
    expect(normalized.length).toBe(48);
    expect(normalized).toBe('x'.repeat(48));
  });

  it('falls back to a default name when nothing usable survives normalization', () => {
    expect(normalizeTeamMemberName('***')).toBe('agent');
    expect(normalizeTeamMemberName('   ')).toBe('agent');
  });

  it('is case-insensitive: two labels differing only in case normalize to the same id', () => {
    expect(normalizeTeamMemberName('Worker')).toBe(normalizeTeamMemberName('WORKER'));
  });
});

// ============================================================================
// ensureNativeTeamRoot
// ============================================================================

describe('ensureNativeTeamRoot', () => {
  it('rejects an empty root session id', () => {
    expect(() => ensureNativeTeamRoot('   ')).toThrow(/root session id is required/);
  });

  it('is idempotent for the same session id and keeps createdAt across calls', () => {
    const sessionId = freshSessionId('idempotent');
    const first = ensureNativeTeamRoot(sessionId);
    createdTeamIds.push(first.teamId);
    const second = ensureNativeTeamRoot(sessionId);
    expect(second.teamId).toBe(first.teamId);
    expect(second.mainMemberId).toBe('main');
  });

  it('detects an identity collision when the on-disk team record was tampered with', () => {
    const sessionId = freshSessionId('collision');
    const root = ensureNativeTeamRoot(sessionId);
    createdTeamIds.push(root.teamId);
    const teamFile = path.join(teamDir(root.teamId), 'team.json');
    const record = JSON.parse(fs.readFileSync(teamFile, 'utf-8')) as Record<string, unknown>;
    record.rootSessionId = 'someone-elses-session';
    fs.writeFileSync(teamFile, JSON.stringify(record));

    expect(() => ensureNativeTeamRoot(sessionId)).toThrow(/identity collision/);
  });
});

// ============================================================================
// Environment round trips
// ============================================================================

describe('native team root environment round trip', () => {
  it('reads back exactly what was applied', () => {
    const root = newRoot('root-env');
    applyNativeTeamRootEnvironment(root);
    try {
      expect(readNativeTeamRootFromEnvironment()).toEqual(root);
    } finally {
      clearNativeTeamRootEnvironment(root);
    }
  });

  it('clears only when the currently applied root matches', () => {
    const rootA = newRoot('root-a');
    const rootB = newRoot('root-b');
    applyNativeTeamRootEnvironment(rootA);
    // A stale caller asking to clear a root that is no longer the active one
    // must not blow away whatever is active now.
    clearNativeTeamRootEnvironment(rootB);
    expect(readNativeTeamRootFromEnvironment()).toEqual(rootA);
    clearNativeTeamRootEnvironment(rootA);
    expect(readNativeTeamRootFromEnvironment()).toBeUndefined();
  });

  it('returns undefined when no root env is set at all', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(readNativeTeamRootFromEnvironment()).toBeUndefined();
  });

  it('returns undefined when the main member marker is missing or wrong', () => {
    const root = newRoot('root-bad-main');
    Object.assign(process.env, nativeTeamRootEnvironment(root));
    process.env[SUBAGENT_TEAM_MAIN_MEMBER_ENV] = 'not-main';
    expect(readNativeTeamRootFromEnvironment()).toBeUndefined();
  });

  it('returns undefined when the team id does not match a hash of the session id', () => {
    const root = newRoot('root-forged-id');
    Object.assign(process.env, nativeTeamRootEnvironment(root));
    process.env[SUBAGENT_TEAM_ID_ENV] = 'session-0000000000000000000000000000000';
    expect(readNativeTeamRootFromEnvironment()).toBeUndefined();
  });

  it('returns undefined when the team directory was never created on disk', () => {
    const sessionId = freshSessionId('never-created');
    // Compute env for a root that ensureNativeTeamRoot was never called for.
    const uncommitted: TeamRootContext = {
      version: 1,
      teamId: `session-${'a'.repeat(32)}`,
      rootSessionId: sessionId,
      mainMemberId: 'main',
    };
    Object.assign(process.env, nativeTeamRootEnvironment(uncommitted));
    expect(readNativeTeamRootFromEnvironment()).toBeUndefined();
  });
});

describe('native team member environment round trip', () => {
  it('authenticates the member that was registered and clears with clearNativeTeamMemberEnvironment', () => {
    const root = newRoot('member-env');
    const membership = registerNativeTeamMember({ root, role: 'subagent', name: 'worker' });
    try {
      applyNativeTeamRootEnvironment(root);
      Object.assign(process.env, nativeTeamMemberEnvironment(membership.context));
      const read = readNativeTeamMemberFromEnvironment();
      expect(read?.memberId).toBe('worker');
      expect(read?.token).toBe(membership.context.token);

      // The env this function returns is meant for a child process's spawn
      // env (undefined omits the key there); process.env stringifies
      // `undefined` to the literal string "undefined", so callers that target
      // process.env itself must delete the keys rather than assign into them.
      for (const key of Object.keys(clearNativeTeamMemberEnvironment())) delete process.env[key];
      expect(process.env[SUBAGENT_TEAM_MEMBER_ID_ENV]).toBeUndefined();
      expect(process.env[SUBAGENT_TEAM_MEMBER_TOKEN_ENV]).toBeUndefined();
      expect(readNativeTeamMemberFromEnvironment()).toBeUndefined();
    } finally {
      membership.dispose();
      clearNativeTeamRootEnvironment(root);
    }
  });

  it('rejects a token that does not hash to the registered member', () => {
    const root = newRoot('member-bad-token');
    const membership = registerNativeTeamMember({ root, role: 'subagent', name: 'worker' });
    try {
      applyNativeTeamRootEnvironment(root);
      Object.assign(process.env, nativeTeamMemberEnvironment(membership.context));
      process.env[SUBAGENT_TEAM_MEMBER_TOKEN_ENV] = 'forged-token';
      expect(readNativeTeamMemberFromEnvironment()).toBeUndefined();
    } finally {
      membership.dispose();
      clearNativeTeamRootEnvironment(root);
    }
  });

  it('rejects a member that has left (disposed)', () => {
    const root = newRoot('member-left');
    const membership = registerNativeTeamMember({ root, role: 'subagent', name: 'worker' });
    applyNativeTeamRootEnvironment(root);
    Object.assign(process.env, nativeTeamMemberEnvironment(membership.context));
    membership.dispose();
    expect(readNativeTeamMemberFromEnvironment()).toBeUndefined();
    clearNativeTeamRootEnvironment(root);
  });
});

// ============================================================================
// registerNativeTeamMember — naming, fanout, reservation, takeover
// ============================================================================

describe('registerNativeTeamMember naming', () => {
  it('gives the main role the reserved main id regardless of any name passed', () => {
    const root = newRoot('main-role');
    const membership = registerNativeTeamMember({ root, role: 'main', name: 'ignored' });
    expect(membership.context.memberId).toBe('main');
    membership.dispose();
  });

  it('rejects an explicit request for the reserved name "main"', () => {
    const root = newRoot('explicit-main');
    expect(() => registerNativeTeamMember({ root, role: 'subagent', name: 'Main' })).toThrow(
      /reserved for the root session/,
    );
  });

  it('substitutes a fallback name when an agent-derived name would land on "main"', () => {
    const root = newRoot('derived-main');
    const membership = registerNativeTeamMember({ root, role: 'subagent', agent: 'MAIN' });
    expect(membership.context.memberId).toBe('main-agent');
    membership.dispose();
  });

  it('requires a name or an agent to derive one from', () => {
    const root = newRoot('no-name');
    expect(() => registerNativeTeamMember({ root, role: 'subagent' })).toThrow(
      /needs a name or an agent to derive one from/,
    );
  });

  it('appends 1-based fanout suffixes to fanout children', () => {
    const root = newRoot('fanout');
    const first = registerNativeTeamMember({ root, role: 'subagent', name: 'worker', fanoutIndex: 0 });
    const second = registerNativeTeamMember({ root, role: 'subagent', name: 'worker', fanoutIndex: 1 });
    expect(first.context.memberId).toBe('worker-1');
    expect(second.context.memberId).toBe('worker-2');
    first.dispose();
    second.dispose();
  });

  it('gives concurrent standalone runs of one agent distinct active identities', () => {
    const root = newRoot('same-agent-runs');
    const first = registerNativeTeamMember({ root, role: 'subagent', agent: 'worker', runId: 'a1b2c3d4-run' });
    const second = registerNativeTeamMember({ root, role: 'subagent', agent: 'worker', runId: 'e5f6a7b8-run' });

    expect(first.context.memberId).toBe('worker-a1b2c3d4');
    expect(second.context.memberId).toBe('worker-e5f6a7b8');
    expect(readMember(root, first.context.memberId)).toMatchObject({ active: true, runId: 'a1b2c3d4-run' });
    expect(readMember(root, second.context.memberId)).toMatchObject({ active: true, runId: 'e5f6a7b8-run' });

    first.dispose();
    second.dispose();
  });

  it('latest registration wins for a duplicate name: the old token stops authenticating', () => {
    const root = newRoot('duplicate-name');
    const first = registerNativeTeamMember({ root, role: 'subagent', name: 'worker' });
    applyNativeTeamRootEnvironment(root);
    Object.assign(process.env, nativeTeamMemberEnvironment(first.context));
    expect(readNativeTeamMemberFromEnvironment()?.token).toBe(first.context.token);

    const second = registerNativeTeamMember({ root, role: 'subagent', name: 'worker' });
    expect(second.context.memberId).toBe(first.context.memberId);
    expect(second.context.token).not.toBe(first.context.token);

    // The first token no longer authenticates against the (now overwritten) record.
    Object.assign(process.env, nativeTeamMemberEnvironment(first.context));
    expect(readNativeTeamMemberFromEnvironment()).toBeUndefined();

    // The second token does.
    Object.assign(process.env, nativeTeamMemberEnvironment(second.context));
    expect(readNativeTeamMemberFromEnvironment()?.token).toBe(second.context.token);

    second.dispose();
    clearNativeTeamRootEnvironment(root);
  });

  it('purges the previous holder inbox when a name is taken over by a new token', () => {
    const root = newRoot('purge-inbox');
    const first = registerNativeTeamMember({ root, role: 'subagent', name: 'worker' });
    const inbox = inboxDirFor(root.teamId, first.context.memberId);
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'leftover.json'), '{"stale":true}');
    expect(fs.existsSync(path.join(inbox, 'leftover.json'))).toBe(true);

    const second = registerNativeTeamMember({ root, role: 'subagent', name: 'worker' });
    expect(fs.existsSync(path.join(inbox, 'leftover.json'))).toBe(false);
    second.dispose();
  });

  it('rejects a task whose subject is empty after trimming', () => {
    const root = newRoot('bad-task');
    expect(() =>
      registerNativeTeamMember({ root, role: 'subagent', name: 'worker', task: { id: '1', subject: '   ' } }),
    ).toThrow(/task subject must be between/);
  });

  it('carries agent, runId, childIndex, parentMemberId, and task through to the context', () => {
    const root = newRoot('full-fields');
    const membership = registerNativeTeamMember({
      root,
      role: 'subagent',
      name: 'worker',
      agent: 'reviewer',
      runId: 'run-1',
      childIndex: 2,
      parentMemberId: 'main',
      task: { id: '7', subject: 'Review the diff' },
    });
    expect(membership.context).toMatchObject({
      agent: 'reviewer',
      runId: 'run-1',
      childIndex: 2,
      parentMemberId: 'main',
      task: { id: '7', subject: 'Review the diff' },
    });
    membership.dispose();
  });
});

// ============================================================================
// Runtime messaging. A fast-interval subclass keeps polling deterministic and
// quick; fake timers keep wall-clock reads deterministic, in particular
// letting two writes land in the same millisecond on purpose.
// ============================================================================

class FastTeamChannelService extends NativeTeamChannelService {
  protected override readonly pollIntervalMs = 5;
  protected override readonly replyPollIntervalMs = 5;
  protected override readonly heartbeatIntervalMs = 5;
  protected override readonly gcIntervalMs = 1_000_000;
  protected override readonly askTimeoutMs = 40;
  protected override readonly maxDeliveryAttempts = 3;
}

class OneShotUndeliverableService extends NativeTeamChannelService {
  protected override readonly pollIntervalMs = 5;
  protected override readonly replyPollIntervalMs = 5;
  protected override readonly heartbeatIntervalMs = 5;
  protected override readonly gcIntervalMs = 1_000_000;
  protected override readonly askTimeoutMs = 40;
  protected override readonly maxDeliveryAttempts = 1;
}

interface RecordedTool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (result: { content: Array<{ text: string }> }) => void,
    context?: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
}

interface FakePi {
  tools: Map<string, RecordedTool>;
  sendMessageCalls: Array<{
    message: { content: string; details?: Record<string, unknown> };
    options?: Record<string, unknown>;
  }>;
  sendUserMessageCalls: Array<{ content: string; options?: Record<string, unknown> }>;
  shutdownHandlers: Array<() => void>;
  getAllTools: () => Array<{ name: string }>;
  registerTool: (tool: { name: string; execute: RecordedTool['execute'] }) => void;
  sendMessage: (
    message: { content: string; details?: Record<string, unknown> },
    options?: Record<string, unknown>,
  ) => void;
  sendUserMessage: (content: string, options?: Record<string, unknown>) => void;
  on: (event: string, handler: () => void) => void;
}

function makePi(): FakePi {
  const tools = new Map<string, RecordedTool>();
  const pi: FakePi = {
    tools,
    sendMessageCalls: [],
    sendUserMessageCalls: [],
    shutdownHandlers: [],
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    registerTool: (tool) => tools.set(tool.name, tool as RecordedTool),
    sendMessage: (message, options) => pi.sendMessageCalls.push({ message, options }),
    sendUserMessage: (content, options) => pi.sendUserMessageCalls.push({ content, options }),
    on: (event, handler) => {
      if (event === 'session_shutdown') pi.shutdownHandlers.push(handler);
    },
  };
  return pi;
}

function team(): { id: string } {
  return { id: freshSessionId('runtime') };
}

/** Bind `pi`'s runtime as a subagent member of `root` under `name`. */
function bindSubagent(
  service: NativeTeamChannelService,
  pi: FakePi,
  root: TeamRootContext,
  name: string,
): { runtime: NativeTeamRuntime; context: TeamMemberContext; dispose: () => void } {
  const membership = registerNativeTeamMember({ root, role: 'subagent', name });
  Object.assign(process.env, nativeTeamRootEnvironment(root), nativeTeamMemberEnvironment(membership.context));
  const runtime = service.createRuntime(pi as never);
  const context = runtime.bindChildFromEnvironment();
  if (!context) throw new Error('expected bindChildFromEnvironment to bind');
  Object.assign(process.env, clearNativeTeamMemberEnvironment());
  return { runtime, context, dispose: membership.dispose };
}

describe('TeamChannelRuntime message delivery', () => {
  let service: FastTeamChannelService;

  beforeEach(() => {
    service = new FastTeamChannelService();
  });

  it('delivers, then marks seen: a delivery failure leaves the message pending for retry, not lost', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();
    let calls = 0;
    workerPi.sendUserMessage = (content, options) => {
      calls += 1;
      workerPi.sendUserMessageCalls.push({ content, options });
      if (calls === 1) throw new Error('transient host refusal');
    };

    // Fake timers installed before the runtimes bind, so the polling
    // `setInterval` each one schedules is the one `advanceTimersByTimeAsync`
    // actually controls.
    vi.useFakeTimers();
    try {
      const mainRuntime = service.createRuntime(mainPi as never);
      const mainContext = mainRuntime.bindMainSession(sessionId);
      createdTeamIds.push(mainContext.teamId);
      const worker = bindSubagent(service, workerPi, mainContext, 'worker');

      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      await mainTool.execute('call-1', { action: 'send', to: 'worker', message: 'hello worker' });

      // First poll (one pollIntervalMs tick): delivery throws. If the
      // predecessor bug (mark seen, then deliver) were reintroduced, the
      // message would never be retried and `calls` would stay at 1 forever.
      await vi.advanceTimersByTimeAsync(5);
      expect(calls).toBe(1);

      // Second poll: retried because it was never marked seen after the throw.
      await vi.advanceTimersByTimeAsync(5);
      expect(calls).toBe(2);
      expect(workerPi.sendUserMessageCalls[1]?.content).toContain('hello worker');

      // Third poll: already delivered and removed, so it must not be redelivered.
      await vi.advanceTimersByTimeAsync(5);
      expect(calls).toBe(2);

      worker.runtime.dispose();
      mainRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('orders two messages from the same sender written in the same millisecond by seq, not by arrival', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const mainRuntime = service.createRuntime(mainPi as never);
      const mainContext = mainRuntime.bindMainSession(sessionId);
      createdTeamIds.push(mainContext.teamId);
      const worker = bindSubagent(service, workerPi, mainContext, 'worker');

      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      // Both queued while the fake clock is frozen: identical createdAt.
      await mainTool.execute('call-1', { action: 'send', to: 'worker', message: 'first' });
      await mainTool.execute('call-2', { action: 'send', to: 'worker', message: 'second' });

      await vi.advanceTimersByTimeAsync(10);

      const delivered = workerPi.sendUserMessageCalls.map((call) => call.content);
      expect(delivered.some((content) => content.includes('first'))).toBe(true);
      expect(delivered.some((content) => content.includes('second'))).toBe(true);
      const firstIndex = delivered.findIndex((content) => content.includes('first'));
      const secondIndex = delivered.findIndex((content) => content.includes('second'));
      expect(firstIndex).toBeLessThan(secondIndex);

      worker.runtime.dispose();
      mainRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never writes the raw sender token into the message envelope on disk', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    const worker = bindSubagent(service, workerPi, mainContext, 'worker');

    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      await mainTool.execute('call-1', { action: 'send', to: 'worker', message: 'secret-bearing message' });

      const inbox = inboxDirFor(mainContext.teamId, worker.context.memberId);
      const files = fs.readdirSync(inbox).filter((name) => name.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const raw = fs.readFileSync(path.join(inbox, file), 'utf-8');
        expect(raw).not.toContain(mainContext.token);
        const envelope = JSON.parse(raw) as { senderTokenHash?: string };
        expect(envelope.senderTokenHash).toBe(createHash('sha256').update(mainContext.token).digest('hex'));
      }
    } finally {
      worker.runtime.dispose();
      mainRuntime.dispose();
    }
  });

  it('delivers to the main role over sendMessage, including sender agent and task metadata', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();

    vi.useFakeTimers();
    try {
      const mainRuntime = service.createRuntime(mainPi as never);
      const mainContext = mainRuntime.bindMainSession(sessionId);
      createdTeamIds.push(mainContext.teamId);
      const membership = registerNativeTeamMember({
        root: mainContext,
        role: 'subagent',
        name: 'worker',
        agent: 'reviewer',
        task: { id: '9', subject: 'Ship the fix' },
      });
      Object.assign(
        process.env,
        nativeTeamRootEnvironment(mainContext),
        nativeTeamMemberEnvironment(membership.context),
      );
      const workerRuntime = service.createRuntime(workerPi as never);
      const workerContext = workerRuntime.bindChildFromEnvironment();
      if (!workerContext) throw new Error('expected bindChildFromEnvironment to bind');
      Object.assign(process.env, clearNativeTeamMemberEnvironment());

      const workerTool = workerPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!workerTool) throw new Error('tool not registered');
      await workerTool.execute('call-1', { action: 'send', to: 'main', message: 'status update' });

      await vi.advanceTimersByTimeAsync(5);

      expect(mainPi.sendMessageCalls.length).toBe(1);
      const delivered = mainPi.sendMessageCalls[0];
      expect(delivered?.message.content).toContain('status update');
      expect(delivered?.message.content).toContain('reviewer');
      expect(delivered?.message.content).toContain('Message from worker (reviewer), task 9.');
      expect(delivered?.message.content).not.toContain('Ship the fix');
      expect(delivered?.message.details).toMatchObject({ from: 'worker', to: 'main' });
      expect(delivered?.options).toEqual({ triggerTurn: true, deliverAs: 'steer' });

      workerRuntime.dispose();
      membership.dispose();
      mainRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolveTarget refuses to guess when two active members share the same agent name', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    const first = registerNativeTeamMember({
      root: mainContext,
      role: 'subagent',
      name: 'worker-a',
      agent: 'reviewer',
    });
    const second = registerNativeTeamMember({
      root: mainContext,
      role: 'subagent',
      name: 'worker-b',
      agent: 'reviewer',
    });

    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      await expect(mainTool.execute('call-1', { action: 'send', to: 'reviewer', message: 'hi' })).rejects.toThrow(
        /\[recipient_ambiguous\].*Multiple active intercom members match/,
      );
    } finally {
      first.dispose();
      second.dispose();
      mainRuntime.dispose();
    }
  });

  it('removes an unparseable file in the recipient own inbox, an expired message, and one from an unauthenticated sender', async () => {
    const { id: sessionId } = team();
    const workerPi = makePi();
    const mainPi = makePi();

    vi.useFakeTimers();
    try {
      const mainRuntime = service.createRuntime(mainPi as never);
      const root = mainRuntime.bindMainSession(sessionId);
      createdTeamIds.push(root.teamId);
      const worker = bindSubagent(service, workerPi, root, 'worker');
      const inbox = inboxDirFor(root.teamId, worker.context.memberId);

      const corruptFile = path.join(inbox, 'corrupt-message.json');
      fs.writeFileSync(corruptFile, 'not json at all');

      const expiredFile = path.join(inbox, 'expired-message.json');
      fs.writeFileSync(
        expiredFile,
        JSON.stringify({
          type: 'subagent.team.message',
          version: 2,
          id: 'expired-message',
          teamId: root.teamId,
          kind: 'send',
          fromMemberId: 'main',
          toMemberId: worker.context.memberId,
          // Expiry is checked before authentication, so this value is never
          // even read for this message.
          senderTokenHash: 'irrelevant-expired-before-auth-check',
          seq: 1,
          message: 'too late',
          createdAt: Date.now() - 2,
          expiresAt: Date.now() - 1,
        }),
      );

      const unauthenticatedFile = path.join(inbox, 'unauthenticated-message.json');
      fs.writeFileSync(
        unauthenticatedFile,
        JSON.stringify({
          type: 'subagent.team.message',
          version: 2,
          id: 'unauthenticated-message',
          teamId: root.teamId,
          kind: 'send',
          fromMemberId: 'main',
          toMemberId: worker.context.memberId,
          senderTokenHash: 'not-the-real-hash',
          seq: 1,
          message: 'forged',
          createdAt: Date.now(),
          expiresAt: Date.now() + 1000,
        }),
      );

      await vi.advanceTimersByTimeAsync(5);

      expect(fs.existsSync(corruptFile)).toBe(false);
      expect(fs.existsSync(expiredFile)).toBe(false);
      expect(fs.existsSync(unauthenticatedFile)).toBe(false);
      expect(workerPi.sendUserMessageCalls).toEqual([]);

      worker.runtime.dispose();
      mainRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails an in-flight ask once the target becomes unreachable instead of waiting out the full timeout', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();

    vi.useFakeTimers();
    try {
      const mainRuntime = service.createRuntime(mainPi as never);
      const mainContext = mainRuntime.bindMainSession(sessionId);
      createdTeamIds.push(mainContext.teamId);
      const worker = bindSubagent(service, workerPi, mainContext, 'worker');

      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      // The catch below is attached to the same promise `askPromise` still
      // refers to (not a new chained one), so a rejection during the advance
      // is never briefly unhandled, and the assertion on `askPromise` itself
      // still sees the rejection. The caught error is asserted on, not
      // discarded, so a wrong or missing rejection still fails the test.
      let askError: unknown;
      const onUpdate = vi.fn();
      const askPromise = mainTool.execute(
        'ask-1',
        { action: 'ask', to: 'worker', message: 'Ping?' },
        undefined,
        onUpdate,
        undefined as never,
      );
      askPromise.catch((error: unknown) => {
        askError = error;
      });

      // The worker leaves before replying.
      worker.dispose();

      await vi.advanceTimersByTimeAsync(10);
      await expect(askPromise).rejects.toThrow(/became unreachable before replying/);
      expect(askError).toBeInstanceOf(Error);
      expect((askError as Error).message).toMatch(/became unreachable before replying/);
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [{ type: 'text', text: expect.stringMatching(/^Waiting for .* to reply/) }],
        }),
      );

      mainRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a message from a mismatched session as seen instead of re-parsing it on every poll', async () => {
    const { id: sessionId } = team();
    const workerPi = makePi();
    const service2 = new FastTeamChannelService();

    vi.useFakeTimers();
    try {
      const mainRuntimeForRoot = service2.createRuntime(makePi() as never);
      const root = mainRuntimeForRoot.bindMainSession(sessionId);
      createdTeamIds.push(root.teamId);
      const worker = bindSubagent(service2, workerPi, root, 'worker');

      const inbox = inboxDirFor(root.teamId, worker.context.memberId);
      fs.mkdirSync(inbox, { recursive: true });
      const foreignFile = path.join(inbox, 'foreign-message.json');
      fs.writeFileSync(
        foreignFile,
        JSON.stringify({
          type: 'subagent.team.message',
          version: 2,
          id: 'foreign-message',
          // A different team id: the file belongs to a session mismatch.
          teamId: 'session-not-our-team-aaaaaaaaaaaaaaaa',
          kind: 'send',
          fromMemberId: 'main',
          toMemberId: worker.context.memberId,
          senderTokenHash: 'irrelevant',
          seq: 1,
          message: 'not for this team',
          createdAt: Date.now(),
          expiresAt: Date.now() + 1000,
        }),
      );

      // First poll: the file is recognised as foreign and marked seen without
      // being delivered or deleted (it is not ours to destroy).
      await vi.advanceTimersByTimeAsync(10);
      expect(workerPi.sendUserMessageCalls).toEqual([]);
      expect(fs.existsSync(foreignFile)).toBe(true);

      // Corrupt the file. If the module had forgotten to skip an already-seen
      // file name, the next poll would try to parse it, find invalid JSON, and
      // delete it as "corrupt". A correctly bounded scan never reopens it.
      fs.writeFileSync(foreignFile, 'not json');
      await vi.advanceTimersByTimeAsync(10);
      expect(fs.existsSync(foreignFile)).toBe(true);
      expect(fs.readFileSync(foreignFile, 'utf-8')).toBe('not json');

      worker.runtime.dispose();
      mainRuntimeForRoot.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the undeliverable history so a long session does not grow it without limit', async () => {
    const { id: sessionId } = team();
    const oneShotService = new OneShotUndeliverableService();
    const mainPi = makePi();
    const workerPi = makePi();
    workerPi.sendUserMessage = () => {
      throw new Error('host always refuses');
    };

    vi.useFakeTimers();
    try {
      const mainRuntime = oneShotService.createRuntime(mainPi as never);
      const mainContext = mainRuntime.bindMainSession(sessionId);
      createdTeamIds.push(mainContext.teamId);
      const worker = bindSubagent(oneShotService, workerPi, mainContext, 'worker');

      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      const total = 40;
      for (let index = 0; index < total; index += 1) {
        await mainTool.execute(`call-${index}`, { action: 'send', to: 'worker', message: `msg-${index}` });
      }

      await vi.advanceTimersByTimeAsync(10);

      const undeliverable = worker.runtime.undeliverable();
      expect(undeliverable.length).toBe(32);
      // The oldest entries were evicted, so only the tail of the 40 remains.
      expect(undeliverable[0]?.reason).toContain('host always refuses');
      expect(workerPi.sendMessageCalls.at(-1)?.options).toEqual({ triggerTurn: true, deliverAs: 'steer' });

      worker.runtime.dispose();
      mainRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TeamChannelRuntime ask/reply', () => {
  let service: FastTeamChannelService;

  beforeEach(() => {
    service = new FastTeamChannelService();
  });

  it('round-trips an ask through the reply tool action', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();

    vi.useFakeTimers();
    try {
      const mainRuntime = service.createRuntime(mainPi as never);
      const mainContext = mainRuntime.bindMainSession(sessionId);
      createdTeamIds.push(mainContext.teamId);
      const worker = bindSubagent(service, workerPi, mainContext, 'worker');

      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      const workerTool = workerPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool || !workerTool) throw new Error('tool not registered');

      const askPromise = mainTool.execute('ask-1', { action: 'ask', to: 'worker', message: 'What is the status?' });

      await vi.advanceTimersByTimeAsync(10);
      // Worker sees the ask delivered as a steered user message.
      expect(workerPi.sendUserMessageCalls[0]?.content).toContain('What is the status?');

      const pending = await workerTool.execute('pending-1', { action: 'pending' });
      const pendingIds = ((pending.details?.pending ?? []) as Array<{ id: string }>).map((entry) => entry.id);
      expect(pendingIds.length).toBe(1);
      const [askId] = pendingIds;

      await workerTool.execute('reply-1', { action: 'reply', requestId: askId, message: 'All good' });
      // `waitForReply`'s poll loop is already waiting on a fake-timer-backed
      // delay; advancing keeps driving that same clock rather than abandoning
      // it mid-flight (switching to real timers here would orphan the
      // already-scheduled fake timeout and hang the test).
      await vi.advanceTimersByTimeAsync(20);
      const result = await askPromise;
      expect(result.content[0]?.text).toContain('All good');

      worker.runtime.dispose();
      mainRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out an ask when no reply arrives, and the request cannot be replied to afterward', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();

    vi.useFakeTimers();
    try {
      const mainRuntime = service.createRuntime(mainPi as never);
      const mainContext = mainRuntime.bindMainSession(sessionId);
      createdTeamIds.push(mainContext.teamId);
      const worker = bindSubagent(service, workerPi, mainContext, 'worker');

      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      const workerTool = workerPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool || !workerTool) throw new Error('tool not registered');

      // The catch below is attached to the same promise `askPromise` still
      // refers to (not a new chained one), so a rejection during the advance
      // is never briefly unhandled, and the assertion on `askPromise` itself
      // still sees the rejection. The caught error is asserted on, not
      // discarded, so a wrong or missing rejection still fails the test.
      let askError: unknown;
      const askPromise = mainTool.execute('ask-1', { action: 'ask', to: 'worker', message: 'Ping?' });
      askPromise.catch((error: unknown) => {
        askError = error;
      });
      await vi.advanceTimersByTimeAsync(1000);

      await expect(askPromise).rejects.toThrow(/Timed out waiting/);
      expect(askError).toBeInstanceOf(Error);
      expect((askError as Error).message).toMatch(/Timed out waiting/);

      vi.useRealTimers();
      await expect(
        workerTool.execute('reply-late', { action: 'reply', requestId: 'whatever', message: 'too late' }),
      ).rejects.toThrow(/\[recipient_not_found\].*No pending intercom ask matches/);

      worker.runtime.dispose();
      mainRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an ask via abort signal', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    const worker = bindSubagent(service, workerPi, mainContext, 'worker');

    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      const controller = new AbortController();
      const askPromise = mainTool.execute(
        'ask-1',
        { action: 'ask', to: 'worker', message: 'Ping?' },
        controller.signal,
      );
      controller.abort();
      await expect(askPromise).rejects.toThrow(/cancelled/);
    } finally {
      worker.runtime.dispose();
      mainRuntime.dispose();
    }
  });
});

describe('TeamChannelRuntime tool actions', () => {
  let service: FastTeamChannelService;

  beforeEach(() => {
    service = new FastTeamChannelService();
  });

  it('members reports active identities', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    const worker = bindSubagent(service, workerPi, mainContext, 'worker');

    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');

      const list = await mainTool.execute('members-1', { action: 'members' });
      const names = ((list.details?.members ?? []) as Array<{ name: string }>).map((member) => member.name);
      expect(names.sort()).toEqual(['main', 'worker']);
    } finally {
      worker.runtime.dispose();
      mainRuntime.dispose();
    }
  });

  it('exposes the same active, public member snapshot through the package API', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    const worker = bindSubagent(service, workerPi, mainContext, 'worker');

    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      const listed = await mainTool.execute('members-api', { action: 'members' });

      expect(readActiveTeamSnapshot()?.members).toEqual(listed.details?.members);

      worker.dispose();
      expect(readActiveTeamSnapshot()?.members.map((member) => member.name)).toEqual(['main']);
    } finally {
      worker.runtime.dispose();
      mainRuntime.dispose();
    }
  });

  it('reports send as queued rather than falsely delivered', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    const worker = bindSubagent(service, workerPi, mainContext, 'worker');

    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      const result = await mainTool.execute('send-1', { action: 'send', to: 'worker', message: 'hello' });
      expect(result.details).toMatchObject({ state: 'queued', delivered: false, to: 'worker' });
      expect(result.content[0]?.text).toContain('Do not resend');

      await vi.waitFor(() => expect(workerPi.sendUserMessageCalls).toHaveLength(1));
      const replay = await mainTool.execute('send-1', { action: 'send', to: 'worker', message: 'hello' });
      expect(replay.details).toMatchObject({ state: 'delivered', delivered: true, to: 'worker' });
      expect(workerPi.sendUserMessageCalls).toHaveLength(1);
    } finally {
      worker.runtime.dispose();
      mainRuntime.dispose();
    }
  });

  it('rejects sending to a target that does not exist', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      await expect(mainTool.execute('call-1', { action: 'send', to: 'ghost', message: 'hi' })).rejects.toThrow(
        /was not found/,
      );
    } finally {
      mainRuntime.dispose();
    }
  });

  it('rejects an empty message', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      await expect(mainTool.execute('call-1', { action: 'send', to: 'main', message: '   ' })).rejects.toThrow(
        /message is required/,
      );
    } finally {
      mainRuntime.dispose();
    }
  });

  it('rejects an unsupported action', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push((mainRuntime.current() as TeamMemberContext).teamId);
    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      await expect(mainTool.execute('call-1', { action: 'delete' } as never)).rejects.toThrow(
        /\[unsupported_operation\].*Unsupported intercom action/,
      );
    } finally {
      mainRuntime.dispose();
    }
  });
});

// ============================================================================
// NativeTeamChannelService
// ============================================================================

describe('NativeTeamChannelService', () => {
  it('reuses the same runtime for the same host instance', () => {
    const service = new FastTeamChannelService();
    const pi = makePi();
    const first = service.createRuntime(pi as never);
    const second = service.createRuntime(pi as never);
    expect(second).toBe(first);
  });

  it('gives two different host instances independent runtimes', () => {
    const service = new FastTeamChannelService();
    const first = service.createRuntime(makePi() as never);
    const second = service.createRuntime(makePi() as never);
    expect(second).not.toBe(first);
  });

  it('disposes and reuses the registered runtime when the host reports session_shutdown', () => {
    const { id: sessionId } = team();
    const service = new FastTeamChannelService();
    const pi = makePi();
    const runtime = service.createRuntime(pi as never);
    const context = runtime.bindMainSession(sessionId);
    createdTeamIds.push(context.teamId);

    expect(pi.shutdownHandlers.length).toBe(1);
    pi.shutdownHandlers[0]?.();
    expect(runtime.current()).toBeUndefined();

    // The tool remains registered on the host, so the same runtime is rebound.
    const rebound = service.createRuntime(pi as never);
    expect(rebound).toBe(runtime);
  });

  it('registerClient binds a child only when the environment names one', () => {
    const service = new FastTeamChannelService();
    const pi = makePi();
    for (const key of ENV_KEYS) delete process.env[key];
    service.registerClient(pi as never);
    expect(service.createRuntime(pi as never).current()).toBeUndefined();
  });

  it('registerClient binds this process as the team member named in its environment', () => {
    const { id: sessionId } = team();
    const bindingService = new FastTeamChannelService();
    const bootstrapPi = makePi();
    const bootstrapRuntime = bindingService.createRuntime(bootstrapPi as never);
    const root = bootstrapRuntime.bindMainSession(sessionId);
    createdTeamIds.push(root.teamId);
    const membership = registerNativeTeamMember({ root, role: 'subagent', name: 'worker' });
    Object.assign(process.env, nativeTeamRootEnvironment(root), nativeTeamMemberEnvironment(membership.context));

    try {
      const clientService = new FastTeamChannelService();
      const clientPi = makePi();
      clientService.registerClient(clientPi as never);
      expect(clientService.createRuntime(clientPi as never).current()?.memberId).toBe('worker');
    } finally {
      Object.assign(process.env, clearNativeTeamMemberEnvironment());
      membership.dispose();
      bootstrapRuntime.dispose();
    }
  });
});

// ============================================================================
// pendingAsksAddressedTo — a read-only, runner-side query for unanswered asks
// addressed to a member other than the caller.
// ============================================================================

describe('pendingAsksAddressedTo authentication', () => {
  it('rejects a caller whose own membership has left (disposed)', () => {
    const { id: sessionId } = team();
    const service = new FastTeamChannelService();
    const mainPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    mainRuntime.dispose();

    expect(() => pendingAsksAddressedTo(mainContext, 'worker', Date.now())).toThrow(/no longer active/);
  });

  it('rejects a caller presenting a token that does not match its own member record', () => {
    const root = newRoot('pending-forged-caller');
    const membership = registerNativeTeamMember({ root, role: 'subagent', name: 'caller' });
    const forged: TeamMemberContext = { ...membership.context, token: 'wrong-token' };

    expect(() => pendingAsksAddressedTo(forged, 'worker', Date.now())).toThrow(/no longer active/);
    membership.dispose();
  });

  it('rejects a caller with no membership at all: a valid root but a member id that was never registered', () => {
    const root = newRoot('pending-no-membership');
    const neverRegistered: TeamMemberContext = {
      ...root,
      memberId: 'nobody',
      token: 'some-token',
      role: 'subagent',
    };

    expect(() => pendingAsksAddressedTo(neverRegistered, 'worker', Date.now())).toThrow(/no longer active/);
  });

  it('does not require the target member to be active, only the caller', () => {
    // The whole point is checking on a member from outside its own process;
    // requiring the target to independently prove itself would defeat that.
    const root = newRoot('pending-inactive-target');
    const caller = registerNativeTeamMember({ root, role: 'main' });
    try {
      expect(() => pendingAsksAddressedTo(caller.context, 'never-registered', Date.now())).not.toThrow();
      expect(pendingAsksAddressedTo(caller.context, 'never-registered', Date.now())).toEqual([]);
    } finally {
      caller.dispose();
    }
  });
});

describe('pendingAsksAddressedTo read-only behaviour', () => {
  let service: FastTeamChannelService;

  beforeEach(() => {
    service = new FastTeamChannelService();
  });

  it('returns the same result on repeated calls, and the ask is still delivered and answerable normally afterward', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();

    vi.useFakeTimers();
    try {
      const mainRuntime = service.createRuntime(mainPi as never);
      const mainContext = mainRuntime.bindMainSession(sessionId);
      createdTeamIds.push(mainContext.teamId);
      const worker = bindSubagent(service, workerPi, mainContext, 'worker');

      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      const workerTool = workerPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool || !workerTool) throw new Error('tool not registered');

      const askPromise = mainTool.execute('ask-1', { action: 'ask', to: 'worker', message: 'Any blockers?' });
      await vi.advanceTimersByTimeAsync(5);

      const now = Date.now();
      const first = pendingAsksAddressedTo(mainContext, 'worker', now);
      const second = pendingAsksAddressedTo(mainContext, 'worker', now);
      expect(first).toEqual(second);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ fromMemberId: 'main' });
      expect(typeof first[0]?.id).toBe('string');
      expect(typeof first[0]?.createdAt).toBe('number');
      // The minimum needed, not the message body.
      expect(Object.keys(first[0] as PendingTeamAsk).sort()).toEqual(['createdAt', 'fromMemberId', 'id']);

      // Neither read above consumed anything: the worker still sees the same
      // ask through its own normal `pending` action and can reply to it.
      const pendingResult = await workerTool.execute('pending-1', { action: 'pending' });
      const pendingIds = ((pendingResult.details?.pending ?? []) as Array<{ id: string }>).map((entry) => entry.id);
      expect(pendingIds).toEqual([first[0]?.id]);

      const askId = first[0]!.id;
      await workerTool.execute('reply-1', { action: 'reply', requestId: askId, message: 'None' });
      await vi.advanceTimersByTimeAsync(20);
      const result = await askPromise;
      expect(result.content[0]?.text).toContain('None');

      // Answered now: the diagnostic query reflects that too.
      expect(pendingAsksAddressedTo(mainContext, 'worker', Date.now())).toEqual([]);

      worker.runtime.dispose();
      mainRuntime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes send-kind messages sitting in the same inbox', async () => {
    const { id: sessionId } = team();
    const mainPi = makePi();
    const workerPi = makePi();
    const mainRuntime = service.createRuntime(mainPi as never);
    const mainContext = mainRuntime.bindMainSession(sessionId);
    createdTeamIds.push(mainContext.teamId);
    const worker = bindSubagent(service, workerPi, mainContext, 'worker');

    try {
      const mainTool = mainPi.tools.get(NATIVE_TEAM_TOOL_NAME);
      if (!mainTool) throw new Error('tool not registered');
      await mainTool.execute('call-1', { action: 'send', to: 'worker', message: 'fyi, not a question' });

      expect(pendingAsksAddressedTo(mainContext, 'worker', Date.now())).toEqual([]);
    } finally {
      worker.runtime.dispose();
      mainRuntime.dispose();
    }
  });

  it('excludes a corrupt, expired, or unauthenticated-sender file, and leaves every one of them untouched on disk', () => {
    const root = newRoot('pending-exclusions');
    const caller = registerNativeTeamMember({ root, role: 'main' });
    const worker = registerNativeTeamMember({ root, role: 'subagent', name: 'worker' });

    try {
      const inbox = inboxDirFor(root.teamId, 'worker');
      fs.mkdirSync(inbox, { recursive: true });

      const corruptFile = path.join(inbox, 'corrupt.json');
      fs.writeFileSync(corruptFile, 'not json');

      const expiredFile = path.join(inbox, 'expired.json');
      fs.writeFileSync(
        expiredFile,
        JSON.stringify({
          type: 'subagent.team.message',
          version: 2,
          id: 'expired',
          teamId: root.teamId,
          kind: 'ask',
          fromMemberId: 'main',
          toMemberId: 'worker',
          senderTokenHash: 'irrelevant-expired-before-auth-check',
          seq: 1,
          message: 'old question',
          createdAt: Date.now() - 2,
          expiresAt: Date.now() - 1,
        }),
      );

      const unauthenticatedFile = path.join(inbox, 'unauthenticated.json');
      fs.writeFileSync(
        unauthenticatedFile,
        JSON.stringify({
          type: 'subagent.team.message',
          version: 2,
          id: 'unauthenticated',
          teamId: root.teamId,
          kind: 'ask',
          fromMemberId: 'main',
          toMemberId: 'worker',
          senderTokenHash: 'not-the-real-hash',
          seq: 1,
          message: 'forged question',
          createdAt: Date.now(),
          expiresAt: Date.now() + 1000,
        }),
      );

      const result = pendingAsksAddressedTo(caller.context, 'worker', Date.now());

      expect(result).toEqual([]);
      expect(fs.existsSync(corruptFile)).toBe(true);
      expect(fs.readFileSync(corruptFile, 'utf-8')).toBe('not json');
      expect(fs.existsSync(expiredFile)).toBe(true);
      expect(fs.existsSync(unauthenticatedFile)).toBe(true);
    } finally {
      worker.dispose();
      caller.dispose();
    }
  });
});
