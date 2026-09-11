import { describe, expect, it } from 'vitest';

import { AdmissionGate } from '../../src/adapters/runs/shared/admissionGate';
import { TEST_SESSION_SCOPE } from '../support/sessionScope';

/** Live children whose lifetime the test controls, standing in for real processes. */
class FakeChildren {
  private live = new Set<number>();
  private next = 1;
  maxObserved = 0;

  start(): number {
    const id = this.next;
    this.next += 1;
    this.live.add(id);
    this.maxObserved = Math.max(this.maxObserved, this.live.size);
    return id;
  }

  exitOldest(): void {
    const oldest = this.live.values().next();
    if (!oldest.done) this.live.delete(oldest.value);
  }

  count(): number {
    return this.live.size;
  }
}

describe('AdmissionGate', () => {
  it('admits while below the ceiling and returns the slot on release', async () => {
    const gate = new AdmissionGate({ countLiveRuns: () => 0, wait: async () => {} });

    const ticket = await gate.admit({ sessionScope: TEST_SESSION_SCOPE, maxLiveRuns: 1, timeoutMs: 0 });
    // A second admission with the first still held has no slot and no time to wait for one.
    await expect(gate.admit({ sessionScope: TEST_SESSION_SCOPE, maxLiveRuns: 1, timeoutMs: 0 })).rejects.toThrow(
      /No child slot became available/,
    );

    ticket.release();
    await expect(gate.admit({ sessionScope: TEST_SESSION_SCOPE, maxLiveRuns: 1, timeoutMs: 0 })).resolves.toBeDefined();
  });

  it('never lets concurrent callers exceed the global ceiling', async () => {
    const children = new FakeChildren();
    const gate = new AdmissionGate({
      countLiveRuns: () => children.count(),
      // Every wait frees one child, so the queue drains deterministically.
      wait: async () => children.exitOldest(),
    });

    async function spawnBatch(size: number): Promise<void> {
      await Promise.all(
        Array.from({ length: size }, async () => {
          const ticket = await gate.admit({ sessionScope: TEST_SESSION_SCOPE, maxLiveRuns: 3, timeoutMs: 10_000 });
          children.start();
          ticket.release();
        }),
      );
    }

    // Four concurrent calls of four children each: the old per-call bound
    // would have allowed all sixteen to be alive at once.
    await Promise.all([spawnBatch(4), spawnBatch(4), spawnBatch(4), spawnBatch(4)]);

    expect(children.maxObserved).toBeLessThanOrEqual(3);
  });

  it('reports a wait and a timeout so saturation is observable', async () => {
    const events: string[] = [];
    const gate = new AdmissionGate({
      countLiveRuns: () => 2,
      wait: async () => {},
      now: () => 0,
    });

    await expect(
      gate.admit({
        sessionScope: TEST_SESSION_SCOPE,
        maxLiveRuns: 2,
        timeoutMs: 0,
        report: (event) => events.push(event),
      }),
    ).rejects.toThrow('raise parallel.maxLiveRuns');

    expect(events).toEqual(['doom_team.admission_wait', 'doom_team.admission_timeout']);
  });

  it('waits on its own timer when no sleep is injected', async () => {
    // Saturated on the first check only, so the gate has to sleep once.
    let counts = 0;
    const gate = new AdmissionGate({
      countLiveRuns: () => (counts++ === 0 ? 1 : 0),
      pollIntervalMs: 1,
    });

    await expect(
      gate.admit({ sessionScope: TEST_SESSION_SCOPE, maxLiveRuns: 1, timeoutMs: 5_000 }),
    ).resolves.toBeDefined();
  });

  it('keeps serving the queue after a refused admission ahead of it', async () => {
    // Saturated for the first admission only, so the second one queues behind a refusal.
    let counts = 0;
    const gate = new AdmissionGate({
      countLiveRuns: () => (counts++ === 0 ? 1 : 0),
      wait: async () => {},
      now: () => 0,
    });

    const refused = gate.admit({ sessionScope: TEST_SESSION_SCOPE, maxLiveRuns: 1, timeoutMs: 0 });
    const queued = gate.admit({ sessionScope: TEST_SESSION_SCOPE, maxLiveRuns: 1, timeoutMs: 0 });

    await expect(refused).rejects.toThrow(/No child slot became available/);
    await expect(queued).resolves.toBeDefined();
  });

  it('does not report a wait when a slot is free immediately', async () => {
    const events: string[] = [];
    const gate = new AdmissionGate({ countLiveRuns: () => 0, wait: async () => {} });

    await gate.admit({
      sessionScope: TEST_SESSION_SCOPE,
      maxLiveRuns: 4,
      timeoutMs: 0,
      report: (event) => events.push(event),
    });

    expect(events).toEqual([]);
  });
});
