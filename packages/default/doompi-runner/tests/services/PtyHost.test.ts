import { describe, expect, it } from 'vitest';

/** xterm parses writes asynchronously, so the screen lags one tick behind. */
const flushTerminal = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
import { PtyHost } from '../../src/adapters/PtyHost/PtyHost';
import { NodePtySpawner } from '../../src/adapters/PtySpawner/NodePtySpawner';
import { FakeClock, FakeLogFile, FakeProcessControl, FakePtySpawner } from '../doubles.ts';

const ESC = '\u001B';

function harness() {
  const spawner = new FakePtySpawner();
  const logFile = new FakeLogFile();
  const control = new FakeProcessControl(new Set([4242, 4243]));
  const clock = new FakeClock();
  return { host: new PtyHost(spawner, logFile, control, clock), spawner, logFile, control, clock };
}

const request = { id: 'deploy', name: 'deploy', command: 'deploy.sh', cwd: '/repo', sessionId: 'session-a' };

describe('PtyHost.launch', () => {
  it('spawns with a terminal size and reports the run', async () => {
    const { host, spawner } = harness();
    const run = await host.launch(request);

    expect(spawner.last.request).toMatchObject({ command: 'deploy.sh', cwd: '/repo' });
    expect(spawner.last.request.cols).toBeGreaterThan(0);
    expect(run).toMatchObject({ name: 'deploy', pid: 4242, logPath: '/logs/deploy.log' });
  });

  it('honours an explicit terminal size', async () => {
    const { host, spawner } = harness();
    await host.launch({ ...request, cols: 80, rows: 24 });
    expect(spawner.last.request).toMatchObject({ cols: 80, rows: 24 });
  });

  it('writes scrubbed text to the log while the screen keeps the raw frame', async () => {
    const { host, spawner, logFile } = harness();
    const run = await host.launch(request);

    spawner.last.emit(`${ESC}[32m 10%${ESC}[0m\r${ESC}[32m100%${ESC}[0m\r\nready\r\n`);
    await flushTerminal();

    expect(logFile.writes.get('/logs/deploy.log')).toBe(`${ESC}[32m100%${ESC}[0m\nready\n`);
    expect(run.output()).toBe(`${ESC}[32m100%${ESC}[0m\nready\n`);
    expect(run.screen()).toContain('100%');
    expect(run.screen()).toContain('ready');
  });

  it('stops buffering once detached but keeps logging', async () => {
    const { host, spawner, logFile } = harness();
    const run = await host.launch(request);

    spawner.last.emit('before\r\n');
    run.detach();
    spawner.last.emit('after\r\n');

    expect(run.output()).toBe('');
    expect(logFile.writes.get('/logs/deploy.log')).toBe('before\nafter\n');
  });

  it('resolves completion on exit and closes the log', async () => {
    const { host, spawner, logFile } = harness();
    const run = await host.launch(request);

    spawner.last.exit(3);

    await expect(run.completion()).resolves.toEqual({ code: 3, signal: null });
    expect(logFile.closed).toEqual(['/logs/deploy.log']);
    expect(host.get('deploy')).toBeUndefined();
  });

  it('ignores a second exit', async () => {
    const { host, spawner, logFile } = harness();
    const run = await host.launch(request);

    spawner.last.exit(0);
    spawner.last.exit(1);

    await expect(run.completion()).resolves.toEqual({ code: 0, signal: null });
    expect(logFile.closed).toEqual(['/logs/deploy.log']);
  });

  it('forwards raw output to subscribers until they unsubscribe', async () => {
    const { host, spawner } = harness();
    const run = await host.launch(request);
    const seen: string[] = [];

    const unsubscribe = run.onData((data) => seen.push(data));
    spawner.last.emit('one');
    unsubscribe();
    spawner.last.emit('two');

    expect(seen).toEqual(['one']);
  });

  it('resizes both the terminal and the screen model', async () => {
    const { host, spawner } = harness();
    const run = await host.launch(request);

    run.resize(100, 40);

    expect(spawner.last.resized).toEqual([{ cols: 100, rows: 40 }]);
  });
});

describe('PtyHost.write', () => {
  it('appends a newline so the command sees a completed line', async () => {
    const { host, spawner } = harness();
    await host.launch(request);

    expect(host.write('deploy', 'yes')).toBe(true);
    expect(spawner.last.written).toEqual(['yes\n']);
  });

  it('does not double the newline the caller already sent', async () => {
    const { host, spawner } = harness();
    await host.launch(request);

    host.write('deploy', 'yes\n');
    expect(spawner.last.written).toEqual(['yes\n']);
  });

  it('reports a runner this session does not host', async () => {
    const { host } = harness();
    expect(host.write('absent', 'yes')).toBe(false);
  });
});

describe('PtyHost lifecycle', () => {
  it('lists and looks up hosted runs', async () => {
    const { host } = harness();
    await host.launch(request);

    expect(host.get('deploy')?.name).toBe('deploy');
    expect(host.list().map((run) => run.name)).toEqual(['deploy']);
  });

  it('signals a live terminal and forgets it', async () => {
    const { host, spawner, control, clock } = harness();
    const run = await host.launch(request);

    const stopping = run.stop();
    control.die(4242);
    await clock.advance(100);
    await stopping;

    expect(spawner.last.killed).toEqual(['SIGTERM']);
    expect(host.get('deploy')).toBeUndefined();
  });

  it('reports nothing to do when the terminal already exited', async () => {
    const { host, control } = harness();
    const run = await host.launch(request);
    control.die(4242);

    await expect(run.stop()).resolves.toBe(false);
  });

  it('escalates to SIGKILL when the terminal outlasts the grace period', async () => {
    const { host, spawner, clock } = harness();
    const run = await host.launch(request);

    const stopping = run.stop();
    for (let elapsed = 0; elapsed < 2100; elapsed += 100) await clock.advance(100);
    await stopping;

    expect(spawner.last.killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops every hosted terminal on shutdown', async () => {
    const { host, spawner, control, clock } = harness();
    await host.launch(request);
    await host.launch({ ...request, name: 'build' });

    const disposing = host.disposeAll();
    control.die(4242);
    await clock.advance(100);
    control.die(4243);
    await clock.advance(100);
    await disposing;

    expect(host.list()).toEqual([]);
    expect(spawner.spawned.every((pty) => pty.killed.includes('SIGTERM'))).toBe(true);
  });
});

describe('NodePtySpawner compatibility', () => {
  it('requires RMUX instead of loading node-pty', async () => {
    await expect(
      new NodePtySpawner().spawn({
        command: 'echo prompt',
        cwd: '/repo',
        env: {},
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow('Interactive commands require a supported RMUX runtime');
  });
});
