import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TITLE_FRAME_INTERVAL_MS = 80;

interface FakeWorker {
  emit(event: 'error', value: Error): void;
  emit(event: 'exit', value: number): void;
  postMessage: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
}

const workerFixture = vi.hoisted(() => ({
  constructorError: false,
  instances: [] as FakeWorker[],
}));

vi.mock('node:worker_threads', () => ({
  Worker: class {
    private readonly handlers = new Map<string, (value: Error | number) => void>();
    readonly postMessage = vi.fn();
    readonly unref = vi.fn();

    constructor() {
      if (workerFixture.constructorError) throw new Error('Workers unavailable');
      workerFixture.instances.push(this as FakeWorker);
    }

    once(event: string, handler: (value: Error | number) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    emit(event: 'error' | 'exit', value: Error | number) {
      this.handlers.get(event)?.(value);
    }
  },
}));

const { createMainThreadTitleController, createWorkerTitleController } =
  await import('../../src/adapters/shellTitleController.ts');

describe('shell title controller', () => {
  beforeEach(() => {
    workerFixture.constructorError = false;
    workerFixture.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('runs title animation commands through an unreferenced worker', () => {
    const controller = createWorkerTitleController();
    const worker = workerFixture.instances[0];
    const write = vi.fn();

    controller.set('π - task', write);
    controller.start('π - task', write);
    controller.stop('π - task', write);
    controller.dispose('π - task', write);

    expect(worker?.unref).toHaveBeenCalledOnce();
    expect(worker?.postMessage.mock.calls).toEqual([
      [{ action: 'set', title: 'π - task' }],
      [{ action: 'start', title: 'π - task' }],
      [{ action: 'stop', title: 'π - task' }],
      [{ action: 'dispose', title: 'π - task' }],
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it('uses the main-thread fallback when workers are unavailable', () => {
    workerFixture.constructorError = true;
    const controller = createWorkerTitleController();
    const write = vi.fn();

    controller.start('π - task', write);
    expect(write).toHaveBeenLastCalledWith('⠋ π - task');

    vi.advanceTimersByTime(TITLE_FRAME_INTERVAL_MS);
    expect(write).toHaveBeenLastCalledWith('⠙ π - task');

    controller.stop('π - task', write);
    expect(write).toHaveBeenLastCalledWith('π - task');
  });

  it('replays the last command on the main thread if the worker fails', () => {
    const controller = createWorkerTitleController();
    const worker = workerFixture.instances[0];
    const write = vi.fn();

    controller.set('π - task', write);
    worker?.emit('error', new Error('Worker failed'));

    expect(write).toHaveBeenCalledWith('π - task');
  });

  it('ignores a worker failure before the first command and then uses the fallback', () => {
    const controller = createWorkerTitleController();
    const worker = workerFixture.instances[0];
    const write = vi.fn();

    worker?.emit('error', new Error('Worker failed during startup'));
    expect(write).not.toHaveBeenCalled();

    controller.set('π - task', write);
    worker?.emit('exit', 1);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('π - task');
  });

  it('falls back when posting to the worker fails', () => {
    const controller = createWorkerTitleController();
    const worker = workerFixture.instances[0];
    const write = vi.fn();
    worker?.postMessage.mockImplementation(() => {
      throw new Error('Worker closed');
    });

    controller.dispose('π - task', write);

    expect(write).toHaveBeenCalledWith('π - task');
  });

  it('falls back when the worker exits unexpectedly', () => {
    const controller = createWorkerTitleController();
    const worker = workerFixture.instances[0];
    const write = vi.fn();

    controller.set('π - task', write);
    worker?.emit('exit', 1);

    expect(write).toHaveBeenCalledWith('π - task');
  });

  it('keeps using the worker after it exits cleanly', () => {
    const controller = createWorkerTitleController();
    const worker = workerFixture.instances[0];
    const write = vi.fn();

    controller.dispose('π - task', write);
    worker?.emit('exit', 0);

    expect(write).not.toHaveBeenCalled();
  });

  it('restarts the animation from the first frame after a stop', () => {
    const controller = createMainThreadTitleController();
    const write = vi.fn();

    controller.start('π - first', write);
    vi.advanceTimersByTime(TITLE_FRAME_INTERVAL_MS);
    expect(write).toHaveBeenLastCalledWith('⠙ π - first');

    controller.stop('π - first', write);
    controller.start('π - second', write);

    expect(write).toHaveBeenLastCalledWith('⠋ π - second');
  });

  it('supports one-shot and disposal updates without a worker', () => {
    const controller = createMainThreadTitleController();
    const write = vi.fn();

    controller.set('π - first', write);
    controller.dispose('π - done', write);

    expect(write.mock.calls).toEqual([['π - first'], ['π - done']]);
  });
});
