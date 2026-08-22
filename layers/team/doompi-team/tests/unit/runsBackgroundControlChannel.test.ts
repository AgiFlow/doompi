import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  claimSteerRequestsFromDir,
  closeSteerInbox,
  consumeInterruptRequest,
  consumeSteerAcks,
  consumeSteerCapabilities,
  consumeStopRequest,
  consumeTimeoutRequest,
  ControlChannelWatcher,
  deliverInterruptRequest,
  requestAsyncInterrupt,
  requestAsyncSteer,
  requestAsyncStop,
  requestAsyncTimeout,
  steerRequestsDir,
  writeSteerAck,
  writeSteerCapability,
  type ControlChannelWatchHandlers,
} from '../../src/adapters/intercom/supervisorControlChannel';
import type { PollSchedulerContract, PollSubscription } from '../../src/adapters/pollScheduler';

const temporaryDirs: string[] = [];

function makeAsyncDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-control-channel-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Records every subscription handed to `register()` and lets a test invoke a
 * subscriber's `run()` directly, deterministically, instead of depending on
 * real timers or `fs.watch` firing.
 */
class FakePollScheduler implements PollSchedulerContract {
  subscriptions: PollSubscription[] = [];
  wakeCalls = 0;
  unregisterCalls = 0;

  register(subscription: PollSubscription): () => void {
    this.subscriptions.push(subscription);
    return () => {
      this.unregisterCalls++;
    };
  }

  wake(): void {
    this.wakeCalls++;
  }

  start(): void {}
  stop(): void {}
}

describe('steer request path helpers round trip through requestAsyncSteer and consumeInterruptRequest and friends', () => {
  it('writes an interrupt request that consumeInterruptRequest reports once and then no longer finds', () => {
    const asyncDir = makeAsyncDir();
    requestAsyncInterrupt(asyncDir, { source: 'test' });

    expect(consumeInterruptRequest(asyncDir)).toBe(true);
    expect(consumeInterruptRequest(asyncDir)).toBe(false);
  });

  it('writes a timeout request that consumeTimeoutRequest reports exactly once', () => {
    const asyncDir = makeAsyncDir();
    requestAsyncTimeout(asyncDir, { source: 'test' });

    expect(consumeTimeoutRequest(asyncDir)).toBe(true);
    expect(consumeTimeoutRequest(asyncDir)).toBe(false);
  });

  it('writes a stop request that consumeStopRequest reports exactly once', () => {
    const asyncDir = makeAsyncDir();
    requestAsyncStop(asyncDir, { source: 'test' });

    expect(consumeStopRequest(asyncDir)).toBe(true);
    expect(consumeStopRequest(asyncDir)).toBe(false);
  });
});

describe('requestAsyncSteer validation', () => {
  it('rejects an empty message before anything is written to disk', () => {
    const asyncDir = makeAsyncDir();
    expect(() => requestAsyncSteer(asyncDir, { message: '   ' })).toThrow(/empty/);
    expect(fs.existsSync(steerRequestsDir(asyncDir))).toBe(false);
  });

  it('rejects combining targetIndex and targetIndexes in the same request', () => {
    const asyncDir = makeAsyncDir();
    expect(() => requestAsyncSteer(asyncDir, { message: 'hi', targetIndex: 0, targetIndexes: [1, 2] })).toThrow(
      /targetIndexes/,
    );
  });

  it('refuses a new steer once the inbox has been closed', () => {
    const asyncDir = makeAsyncDir();
    closeSteerInbox(asyncDir, 'complete');

    expect(() => requestAsyncSteer(asyncDir, { message: 'too late' })).toThrow(/no longer accepts/);
  });

  it('queues a well-formed steer request as a file in the steer-requests directory', () => {
    const asyncDir = makeAsyncDir();
    const requestPath = requestAsyncSteer(asyncDir, { message: 'wrap up soon', source: 'parent' });

    expect(fs.existsSync(requestPath)).toBe(true);
    expect(path.dirname(requestPath)).toBe(steerRequestsDir(asyncDir));
  });
});

describe('deliverInterruptRequest', () => {
  it('writes the portable request and swallows ENOSYS from an undeliverable OS signal', () => {
    const asyncDir = makeAsyncDir();
    const kill = vi.fn(() => {
      throw Object.assign(new Error('not supported'), { code: 'ENOSYS' });
    });

    expect(() => deliverInterruptRequest({ asyncDir, pid: 4242, kill })).not.toThrow();
    expect(consumeInterruptRequest(asyncDir)).toBe(true);
  });

  it('rethrows a non-ENOSYS signal failure and removes the request file it just wrote', () => {
    const asyncDir = makeAsyncDir();
    const kill = vi.fn(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    expect(() => deliverInterruptRequest({ asyncDir, pid: 4242, kill })).toThrow(/no such process/);
    expect(consumeInterruptRequest(asyncDir)).toBe(false);
  });

  it('delivers the signal on the happy path and leaves the request file for the runner to consume', () => {
    const asyncDir = makeAsyncDir();
    const kill = vi.fn();

    deliverInterruptRequest({ asyncDir, pid: 4242, kill });

    expect(kill).toHaveBeenCalledWith(4242, expect.any(String));
    expect(consumeInterruptRequest(asyncDir)).toBe(true);
  });
});

describe('steer capabilities and acks', () => {
  it('reads back a written steer capability', () => {
    const asyncDir = makeAsyncDir();
    writeSteerCapability(asyncDir, { index: 0, pid: 123, readyAt: Date.now(), supported: true });

    const capabilities = consumeSteerCapabilities(asyncDir);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]).toMatchObject({ index: 0, pid: 123, supported: true });
  });

  it('ignores a malformed capability file rather than throwing', () => {
    const asyncDir = makeAsyncDir();
    const dir = path.join(asyncDir, 'control', 'steer-capabilities');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '0.json'), 'not json');

    expect(consumeSteerCapabilities(asyncDir)).toEqual([]);
  });

  it('consumes a written steer ack exactly once, deleting it from disk', () => {
    const asyncDir = makeAsyncDir();
    writeSteerAck(asyncDir, { requestId: 'req-1', index: 0, ts: Date.now(), state: 'delivered', message: 'ok' });

    expect(consumeSteerAcks(asyncDir)).toHaveLength(1);
    expect(consumeSteerAcks(asyncDir)).toEqual([]);
  });
});

describe('FIX 2: removeIfPresent distinguishes a missing file from a real deletion failure', () => {
  it('treats a request already gone as a normal, silent no-op', () => {
    const asyncDir = makeAsyncDir();
    requestAsyncInterrupt(asyncDir);
    // Simulate a second consumer that already removed the same file.
    fs.rmSync(path.join(asyncDir, 'control', 'interrupt.json'), { force: true });

    expect(consumeInterruptRequest(asyncDir)).toBe(false);
  });

  it('surfaces a genuine deletion failure instead of silently reporting the request as consumed', () => {
    const asyncDir = makeAsyncDir();
    requestAsyncInterrupt(asyncDir);
    const brokenFs = {
      existsSync: fs.existsSync,
      rmSync: vi.fn(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }),
    };

    expect(() => consumeInterruptRequest(asyncDir, brokenFs)).toThrow(/permission denied/);
  });
});

describe('FIX 1: steer requests are claimed by rename, not deleted before dispatch', () => {
  function writeOneSteerRequest(asyncDir: string, message = 'steer message'): void {
    requestAsyncSteer(asyncDir, { message });
  }

  it('claims a queued request, moving it out of the queue directory', () => {
    const asyncDir = makeAsyncDir();
    writeOneSteerRequest(asyncDir);
    const dir = steerRequestsDir(asyncDir);
    const originalEntries = fs.readdirSync(dir);
    expect(originalEntries).toHaveLength(1);

    const claims = claimSteerRequestsFromDir(dir);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.request.message).toBe('steer message');
    // The claimed file is no longer a plain queue entry: nothing re-lists it.
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.json'))).toEqual([]);
  });

  it('leaves the message recoverable on disk when dispatch throws and release() is called', () => {
    const asyncDir = makeAsyncDir();
    writeOneSteerRequest(asyncDir, 'do not lose me');
    const dir = steerRequestsDir(asyncDir);
    const [entryName] = fs.readdirSync(dir);
    if (!entryName) throw new Error('expected one queued steer request file');
    const originalPath = path.join(dir, entryName);

    const [claim] = claimSteerRequestsFromDir(dir);
    if (!claim) throw new Error('expected exactly one claim');
    expect(fs.existsSync(originalPath)).toBe(false);

    // Stands in for a dispatch that throws. The error is captured and asserted
    // rather than discarded, so this cannot pass if the simulation stops
    // throwing and the release path is never actually exercised.
    let dispatchError: unknown;
    try {
      throw new Error('dispatch failed');
    } catch (error) {
      dispatchError = error;
      claim.release();
    }
    expect(dispatchError).toBeInstanceOf(Error);
    expect((dispatchError as Error).message).toBe('dispatch failed');

    // FIX 1: a throw during dispatch must not lose the message - it is back
    // under its original name, byte-for-byte, ready for the next scan.
    expect(fs.existsSync(originalPath)).toBe(true);
    const recovered = JSON.parse(fs.readFileSync(originalPath, 'utf-8')) as { message: string };
    expect(recovered.message).toBe('do not lose me');
  });

  it('permanently deletes the claimed file once commit() is called after a successful dispatch', () => {
    const asyncDir = makeAsyncDir();
    writeOneSteerRequest(asyncDir);
    const dir = steerRequestsDir(asyncDir);
    const [entryName] = fs.readdirSync(dir);
    if (!entryName) throw new Error('expected one queued steer request file');
    const originalPath = path.join(dir, entryName);

    const [claim] = claimSteerRequestsFromDir(dir);
    claim?.commit();

    expect(fs.existsSync(originalPath)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('lets exactly one of two racing consumers claim the same listed request', () => {
    const asyncDir = makeAsyncDir();
    writeOneSteerRequest(asyncDir);
    const dir = steerRequestsDir(asyncDir);
    const staleListing = fs.readdirSync(dir);

    // Both consumers already did their `readdirSync` before either claimed -
    // the realistic race window - so both see the same file name. Everything
    // past that point (renameSync, rmSync, readFileSync) is real `fs`, so the
    // decision is made by the same atomic rename production code relies on.
    const raceFs = { ...fs, readdirSync: (() => staleListing) as unknown as typeof fs.readdirSync };

    const claimsA = claimSteerRequestsFromDir(dir, raceFs, 'consumer-a');
    const claimsB = claimSteerRequestsFromDir(dir, raceFs, 'consumer-b');

    expect(claimsA).toHaveLength(1);
    expect(claimsB).toHaveLength(0);
  });
});

describe('ControlChannelWatcher', () => {
  function handlers(overrides: Partial<ControlChannelWatchHandlers> = {}): ControlChannelWatchHandlers {
    return { onInterrupt: vi.fn(), ...overrides };
  }

  it('fires onInterrupt immediately for a request already waiting when watch() is called', () => {
    const asyncDir = makeAsyncDir();
    requestAsyncInterrupt(asyncDir);
    const scheduler = new FakePollScheduler();
    const watcher = new ControlChannelWatcher(scheduler);
    const onInterrupt = vi.fn();

    const dispose = watcher.watch(asyncDir, handlers({ onInterrupt }), { fs });

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('registers exactly one PollScheduler subscription and unregisters it on dispose', () => {
    const asyncDir = makeAsyncDir();
    const scheduler = new FakePollScheduler();
    const watcher = new ControlChannelWatcher(scheduler);

    const dispose = watcher.watch(asyncDir, handlers(), { fs });
    expect(scheduler.subscriptions).toHaveLength(1);

    dispose();
    expect(scheduler.unregisterCalls).toBe(1);
  });

  it('dispatches a queued steer request through the scheduled subscription and commits it', () => {
    const asyncDir = makeAsyncDir();
    const scheduler = new FakePollScheduler();
    const watcher = new ControlChannelWatcher(scheduler);
    const onSteer = vi.fn();
    const dispose = watcher.watch(asyncDir, handlers({ onSteer }), { fs });

    requestAsyncSteer(asyncDir, { message: 'hello there' });
    const subscription = scheduler.subscriptions[0];
    if (!subscription) throw new Error('expected a registered subscription');
    const workHappened = subscription.run();

    expect(onSteer).toHaveBeenCalledWith(expect.objectContaining({ message: 'hello there' }));
    expect(workHappened).toBe(true);
    expect(fs.readdirSync(steerRequestsDir(asyncDir))).toEqual([]);
    dispose();
  });

  it('leaves a steer request recoverable and surfaces the error when onSteer throws', () => {
    const asyncDir = makeAsyncDir();
    const scheduler = new FakePollScheduler();
    const watcher = new ControlChannelWatcher(scheduler);
    const onSteer = vi.fn(() => {
      throw new Error('handler exploded');
    });
    const dispose = watcher.watch(asyncDir, handlers({ onSteer }), { fs });

    requestAsyncSteer(asyncDir, { message: 'steer me' });
    const subscription = scheduler.subscriptions[0];
    if (!subscription) throw new Error('expected a registered subscription');

    expect(() => subscription.run()).toThrow(/handler exploded/);
    // Not silently deleted (FIX 1): the request file is still on disk, so the
    // next scheduled check retries it.
    const remaining = fs.readdirSync(steerRequestsDir(asyncDir)).filter((name) => name.endsWith('.json'));
    expect(remaining).toHaveLength(1);
    dispose();
  });

  it('leaves outbound steer acknowledgments for the parent when this watcher has no acknowledgment handler', () => {
    const asyncDir = makeAsyncDir();
    writeSteerAck(asyncDir, {
      requestId: 'parent-request',
      index: 0,
      ts: Date.now(),
      state: 'delivered',
      message: 'accepted',
    });
    const scheduler = new FakePollScheduler();
    const watcher = new ControlChannelWatcher(scheduler);
    const dispose = watcher.watch(asyncDir, handlers(), { fs });

    expect(consumeSteerAcks(asyncDir)).toEqual([
      expect.objectContaining({ requestId: 'parent-request', state: 'delivered' }),
    ]);
    dispose();
  });

  it('consumes steer acknowledgments only when this watcher owns an acknowledgment handler', () => {
    const asyncDir = makeAsyncDir();
    const scheduler = new FakePollScheduler();
    const watcher = new ControlChannelWatcher(scheduler);
    const onSteerAck = vi.fn();
    const dispose = watcher.watch(asyncDir, handlers({ onSteerAck }), { fs });
    writeSteerAck(asyncDir, {
      requestId: 'owned-request',
      index: 0,
      ts: Date.now(),
      state: 'delivered',
      message: 'accepted',
    });
    const subscription = scheduler.subscriptions[0];
    if (!subscription) throw new Error('expected a registered subscription');

    expect(subscription.run()).toBe(true);
    expect(onSteerAck).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'owned-request' }));
    expect(consumeSteerAcks(asyncDir)).toEqual([]);
    dispose();
  });
});
