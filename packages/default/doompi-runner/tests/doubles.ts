import fs from 'node:fs';
import path from 'node:path';
import type { IClock } from '../src/types/clock';
import type { ILogFile, LogWriter } from '../src/types/logFile';
import type { IRunnerPaths } from '../src/services/RunnerPaths/types';
import type { IProcessControl } from '../src/types/processControl';
import type { IPtySpawner, PtyProcess, PtySpawnRequest } from '../src/types/ptySpawner';
import type { IRtkProcessor, RtkProcessRequest, RtkProcessResult } from '../src/types/rtkProcessor';
import type { ExitResult, ISpawner, OutputStream, SpawnRequest, SpawnedProcess } from '../src/types/spawner';

/** A clock whose timers only fire when the test advances it. */
export class FakeClock implements IClock {
  private current = 0;
  private timers: Array<{ at: number; handler: () => void; cancelled: boolean }> = [];

  now(): number {
    return this.current;
  }

  after(ms: number, handler: () => void): () => void {
    const timer = { at: this.current + ms, handler, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** Moves time forward and runs whatever became due, yielding between each. */
  async advance(ms: number): Promise<void> {
    this.current += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.current);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) {
      timer.handler();
      await Promise.resolve();
    }
  }

  get pending(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

export interface FakeChild {
  request: SpawnRequest;
  emit(chunk: string, stream?: OutputStream): void;
  exit(result?: ExitResult): void;
  fail(error: Error): void;
  unreffed: boolean;
}

/** A spawner that hands the test direct control over the child's lifecycle. */
export class FakeSpawner implements ISpawner {
  readonly children: FakeChild[] = [];

  /** Explicit rather than defaulted, so a test can spawn a process with no pid. */
  constructor(private readonly pid: number | undefined) {}

  spawn(request: SpawnRequest): SpawnedProcess {
    const outputHandlers: Array<(chunk: string, stream: OutputStream) => void> = [];
    const exitHandlers: Array<(result: ExitResult) => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];
    const child: FakeChild = {
      request,
      emit: (chunk, stream = 'stdout') => {
        for (const handler of outputHandlers) handler(chunk, stream);
      },
      exit: (result = { code: 0, signal: null }) => {
        for (const handler of exitHandlers) handler(result);
      },
      fail: (error) => {
        for (const handler of errorHandlers) handler(error);
      },
      unreffed: false,
    };
    this.children.push(child);

    return {
      pid: this.pid,
      onOutput: (handler) => outputHandlers.push(handler),
      onExit: (handler) => exitHandlers.push(handler),
      onError: (handler) => errorHandlers.push(handler),
      kill: () => undefined,
      unref: () => {
        child.unreffed = true;
      },
    };
  }

  get last(): FakeChild {
    const child = this.children.at(-1);
    if (!child) throw new Error('nothing has been spawned yet');
    return child;
  }
}

/** Captures log writes in memory instead of on disk. */
export class FakeLogFile implements ILogFile {
  readonly writes = new Map<string, string>();
  readonly closed: string[] = [];
  failAppendWith: Error | undefined;
  open(name: string): LogWriter {
    const path = `/logs/${name}.log`;
    this.writes.set(path, '');
    const writes = this.writes;
    const closed = this.closed;
    return {
      path,
      append: (text: string): void => {
        if (this.failAppendWith) throw this.failAppendWith;
        writes.set(path, (writes.get(path) ?? '') + text);
      },
      size(): number {
        return Buffer.byteLength(writes.get(path) ?? '');
      },
      close(): void {
        closed.push(path);
      },
    };
  }
}

/** Runner storage rooted in a real temp directory, so sidecars can be inspected. */
export class FakeRunnerPaths implements IRunnerPaths {
  constructor(private readonly root: string) {}

  repositoryPath(): string {
    return this.root;
  }

  setSessionId(): void {
    return undefined;
  }

  logDirectory(): string {
    return path.join(this.root, 'logs');
  }

  stateDirectory(): string {
    return path.join(this.root, 'runs');
  }

  logPathFor(id: string): string {
    return path.join(this.logDirectory(), `${id}.log`);
  }

  rotatedLogPathFor(id: string): string {
    return `${this.logPathFor(id)}.1`;
  }

  statePathFor(id: string): string {
    return path.join(this.stateDirectory(), `${id}.json`);
  }

  ensureDirectories(): void {
    fs.mkdirSync(this.logDirectory(), { recursive: true });
    fs.mkdirSync(this.stateDirectory(), { recursive: true });
  }

  sweepHistory(): { removed: string[]; errors: string[] } {
    return { removed: [], errors: [] };
  }

  legacyDirectory(): string | undefined {
    return undefined;
  }

  removeLegacyStore(): string | undefined {
    return undefined;
  }
}

/** Process control whose liveness the test sets directly. */
export class FakeProcessControl implements IProcessControl {
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  constructor(private alive = new Set<number>([4242])) {}

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  signalGroup(pid: number, signal: NodeJS.Signals): boolean {
    this.signals.push({ pid, signal });
    return true;
  }

  die(pid: number): void {
    this.alive.delete(pid);
  }
}

/** An RTK processor that records requests and leaves the raw result untouched. */
export class FakeRtkProcessor implements IRtkProcessor {
  readonly requests: RtkProcessRequest[] = [];
  result: RtkProcessResult = { kind: 'skipped' };
  failWith: Error | undefined;

  async process(request: RtkProcessRequest): Promise<RtkProcessResult> {
    this.requests.push(request);
    if (this.failWith) throw this.failWith;
    return this.result;
  }
}

export interface FakePty {
  request: PtySpawnRequest;
  emit(data: string): void;
  exit(exitCode?: number): void;
  readonly written: string[];
  readonly killed: string[];
  readonly resized: Array<{ cols: number; rows: number }>;
}

/** A pty spawner whose terminal the test drives directly. */
export class FakePtySpawner implements IPtySpawner {
  readonly spawned: FakePty[] = [];
  /** Incremented per spawn, so a test can stop two terminals independently. */
  private nextPid: number;

  constructor(firstPid = 4242) {
    this.nextPid = firstPid;
  }

  async spawn(request: PtySpawnRequest): Promise<PtyProcess> {
    const dataHandlers: Array<(data: string) => void> = [];
    const exitHandlers: Array<(result: { exitCode: number }) => void> = [];
    const written: string[] = [];
    const killed: string[] = [];
    const resized: Array<{ cols: number; rows: number }> = [];

    this.spawned.push({
      request,
      emit: (data) => {
        for (const handler of dataHandlers) handler(data);
      },
      exit: (exitCode = 0) => {
        for (const handler of exitHandlers) handler({ exitCode });
      },
      written,
      killed,
      resized,
    });

    const pid = this.nextPid;
    this.nextPid += 1;

    return {
      pid,
      write: (data) => written.push(data),
      resize: (cols, rows) => resized.push({ cols, rows }),
      onData: (handler) => dataHandlers.push(handler),
      onExit: (handler) => exitHandlers.push(handler),
      kill: (signal = 'SIGTERM') => killed.push(signal),
    };
  }

  get last(): FakePty {
    const pty = this.spawned.at(-1);
    if (!pty) throw new Error('nothing has been spawned yet');
    return pty;
  }
}
