import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

const workerFixture = vi.hoisted(() => ({ instances: [] as FakeWorker[] }));

vi.mock('node:worker_threads', () => ({
  Worker: class {
    readonly postMessage = vi.fn();
    readonly unref = vi.fn();

    constructor() {
      workerFixture.instances.push(this as FakeWorker);
    }

    once() {
      return this;
    }
  },
}));

const { notificationExtension } = await import('../../src/adapters/pi/extension.ts');
const { createPiHarness } = await import('../helpers/piHarness.ts');

describe('notification extension without an injected title controller', () => {
  beforeEach(() => {
    workerFixture.instances.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('animates the tab from an unreferenced worker thread', async () => {
    const harness = createPiHarness();

    await notificationExtension(harness.pi, { environment: {} });
    harness.handlers.get('agent_start')?.({ type: 'agent_start' }, harness.context);
    await harness.handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, harness.context);

    const worker = workerFixture.instances[0];
    expect(worker?.unref).toHaveBeenCalledOnce();
    expect(worker?.postMessage.mock.calls).toEqual([
      [{ action: 'start', title: 'π - example' }],
      [{ action: 'dispose', title: 'π - example' }],
    ]);
    expect(harness.setTitle).not.toHaveBeenCalled();
  });
});
