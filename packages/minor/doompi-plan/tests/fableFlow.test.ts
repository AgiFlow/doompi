import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  containsSuspectedCredential,
  createFablePlanFlow,
  FABLE_PLAN_MODEL,
  FABLE_PLAN_PROFILE,
  FABLE_PLAN_REQUESTER,
  FABLE_PLAN_RUNTIME,
  sanitizeFablePacket,
  type FablePlanBroker,
  type FablePlanPacket,
  type FablePlanResult,
} from '../src/exports/fableFlow';

const PACKET: FablePlanPacket = {
  goal: ['Replace slash planning'],
  constraints: ['Keep the repository read-only'],
  decisions: ['Use typed leader actions'],
  verifiedFindings: [{ path: 'packages/minor/doompi-plan/src/planMode.ts', finding: 'Plan owns mode state' }],
  inferredFindings: ['The bridge may need a request broker'],
  unresolvedQuestions: [],
};

function completed(operationId: string, overrides: Partial<FablePlanResult> = {}): FablePlanResult {
  return {
    operationId,
    status: 'completed',
    stage: 'completed',
    draft: 'Draft',
    durationMs: 5,
    ...overrides,
  };
}

function deferredResult() {
  let resolve!: (result: FablePlanResult) => void;
  const promise = new Promise<FablePlanResult>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sanitizeFablePacket', () => {
  it('copies the exact bounded packet shape', () => {
    expect(sanitizeFablePacket({ ...PACKET, currentPlan: '# Current' })).toEqual({
      ...PACKET,
      currentPlan: '# Current',
    });
  });

  it.each([
    [null, 'must be an object'],
    [{ ...PACKET, secret: 'value' }, 'unsupported field'],
    [{ ...PACKET, goal: [] }, 'at least one item'],
    [{ ...PACKET, constraints: 'invalid' }, 'must be an array'],
    [{ ...PACKET, decisions: Array.from({ length: 25 }, () => 'item') }, 'bounded item limit'],
    [{ ...PACKET, goal: ['bad\u0000text'] }, 'control characters'],
    [{ ...PACKET, goal: [`Authorization: Bearer secret-value`] }, 'credential'],
    [{ ...PACKET, verifiedFindings: [{ path: '', finding: 'finding' }] }, 'safe source path'],
    [{ ...PACKET, verifiedFindings: [{ path: 'file.ts', finding: 'finding', extra: true }] }, 'unsupported field'],
  ])('rejects unsafe packet variant %#', (value, message) => {
    expect(() => sanitizeFablePacket(value)).toThrow(message as string);
  });

  it('rejects a packet whose aggregate JSON exceeds the byte ceiling', () => {
    const large = 'x'.repeat(4_000);
    expect(() => sanitizeFablePacket({ ...PACKET, goal: Array.from({ length: 9 }, () => large) })).toThrow(
      'packet size',
    );
  });

  it.each(['api_key=secret', '-----BEGIN PRIVATE KEY-----', 'sk-abcdefghijklmnop', 'ghp_abcdefghijklmnop'])(
    'detects suspected credential syntax',
    (value) => {
      expect(containsSuspectedCredential(value)).toBe(true);
    },
  );

  it('allows ordinary planning text', () => {
    expect(containsSuspectedCredential('No sensitive values are present.')).toBe(false);
  });
});

describe('createFablePlanFlow', () => {
  it('sends only the fixed request profile and returns a safe result', async () => {
    const stages: string[] = [];
    const broker: FablePlanBroker = {
      start: vi.fn(async (request) => {
        expect(request).toMatchObject({
          requester: FABLE_PLAN_REQUESTER,
          runtime: FABLE_PLAN_RUNTIME,
          model: FABLE_PLAN_MODEL,
          profile: FABLE_PLAN_PROFILE,
          packet: PACKET,
        });
        return completed(request.operationId);
      }),
      cancel: vi.fn(),
    };
    const flow = createFablePlanFlow({ broker, isAuthorized: () => true, onStage: (stage) => stages.push(stage) });

    const result = await flow.run(PACKET);
    expect(result).toMatchObject({ status: 'completed', draft: 'Draft' });
    expect(result).not.toHaveProperty('review');
    expect(stages).toEqual(['draft', 'completed']);
    expect(flow.isActive()).toBe(false);
  });

  it('rejects execution outside the authorized Fable ceiling', async () => {
    const flow = createFablePlanFlow({ isAuthorized: () => false });

    await expect(flow.run(PACKET)).rejects.toThrow('not authorized');
  });

  it('fails closed when no same-process broker is installed', async () => {
    const flow = createFablePlanFlow({ isAuthorized: () => true });

    await expect(flow.run(PACKET)).resolves.toMatchObject({ status: 'timed_out', errorCode: 'timeout' });
  });

  it('rejects concurrent operations for one session', async () => {
    const pending = deferredResult();
    const broker: FablePlanBroker = { start: () => pending.promise, cancel: vi.fn() };
    const flow = createFablePlanFlow({ broker, isAuthorized: () => true });
    const first = flow.run(PACKET);

    expect(flow.isActive()).toBe(true);
    await expect(flow.run(PACKET)).rejects.toThrow('already active');
    flow.cancel('stop');
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('cancels once and reports cancellation to the broker', async () => {
    const pending = deferredResult();
    const broker: FablePlanBroker = { start: () => pending.promise, cancel: vi.fn() };
    const stages: string[] = [];
    const flow = createFablePlanFlow({ broker, isAuthorized: () => true, onStage: (stage) => stages.push(stage) });
    const result = flow.run(PACKET);

    flow.cancel();
    flow.cancel();
    await expect(result).resolves.toMatchObject({ status: 'cancelled', stage: 'cancelled' });
    expect(broker.cancel).toHaveBeenCalledOnce();
    expect(stages).toEqual(['draft', 'cancelled']);
  });

  it('honors parent cancellation without exposing broker identity', async () => {
    const pending = deferredResult();
    const broker: FablePlanBroker = { start: () => pending.promise, cancel: vi.fn() };
    const controller = new AbortController();
    const flow = createFablePlanFlow({ broker, isAuthorized: () => true });
    const result = flow.run(PACKET, controller.signal);

    controller.abort(new Error('parent stopped'));
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('does not apply a default aggregate timeout', async () => {
    vi.useFakeTimers();
    const pending = deferredResult();
    const broker: FablePlanBroker = { start: () => pending.promise, cancel: vi.fn() };
    const flow = createFablePlanFlow({ broker, isAuthorized: () => true });
    const result = flow.run(PACKET);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1);
    expect(flow.isActive()).toBe(true);
    pending.resolve(completed('completed-after-default-timeout'));
    await expect(result).resolves.toMatchObject({ status: 'completed', draft: 'Draft' });
    expect(broker.cancel).not.toHaveBeenCalled();
  });

  it('times out explicit overrides, cancels the broker, and clears active state', async () => {
    vi.useFakeTimers();
    const pending = deferredResult();
    const broker: FablePlanBroker = { start: () => pending.promise, cancel: vi.fn() };
    const flow = createFablePlanFlow({ broker, isAuthorized: () => true, timeoutMs: 25 * 60 * 1_000 });
    const result = flow.run(PACKET);

    await vi.advanceTimersByTimeAsync(25 * 60 * 1_000);
    await expect(result).resolves.toMatchObject({ status: 'timed_out', stage: 'interrupted', errorCode: 'timeout' });
    expect(broker.cancel).toHaveBeenCalledOnce();
    expect(flow.isActive()).toBe(false);
  });

  it('converts broker failures to a telemetry-safe result', async () => {
    const error = new Error('vendor details');
    const onError = vi.fn();
    const broker: FablePlanBroker = {
      start: () => Promise.reject(error),
      cancel: vi.fn(),
    };
    const flow = createFablePlanFlow({ broker, isAuthorized: () => true, onError });

    await expect(flow.run(PACKET)).resolves.toMatchObject({ status: 'failed', errorCode: 'unavailable' });
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('rejects output that appears to contain a credential', async () => {
    const broker: FablePlanBroker = {
      start: async (request) => completed(request.operationId, { draft: 'api_key=vendor-secret' }),
      cancel: vi.fn(),
    };
    const flow = createFablePlanFlow({ broker, isAuthorized: () => true });

    await expect(flow.run(PACKET)).resolves.toMatchObject({ status: 'failed', errorCode: 'unsafe_output' });
  });

  it('reports broker cancellation errors without swallowing them', async () => {
    const pending = deferredResult();
    const error = new Error('cancel failed');
    const onError = vi.fn();
    const broker: FablePlanBroker = {
      start: () => pending.promise,
      cancel: () => {
        throw error;
      },
    };
    const flow = createFablePlanFlow({ broker, isAuthorized: () => true, onError });
    const result = flow.run(PACKET);

    flow.cancel('stop');
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
    expect(onError).toHaveBeenCalledWith(error);
  });
});
