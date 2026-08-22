import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';

export interface FakeChildOutcome {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  error?: Error;
  /** Emit nothing at all, so only the runner's own timeout can settle it. */
  stalled?: boolean;
  pid?: number;
}

export type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end(value: string): void };
  kill(signal?: NodeJS.Signals): void;
  pid?: number;
};

/**
 * A spawned process double.
 *
 * Nothing real is started, so a test that leaves a hook stalled cannot leave a
 * process behind with it.
 */
export function fakeChild(payloads: string[], outcome: FakeChildOutcome): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: (value: string) => payloads.push(value) };
  child.kill = () => child.emit('exit', null);
  child.pid = outcome.pid;
  if (!outcome.stalled) {
    setImmediate(() => {
      if (outcome.error) {
        child.emit('error', outcome.error);
        return;
      }
      if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout));
      if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr));
      // An explicit null is a real case: a signalled child exits with no code.
      child.emit('exit', outcome.code === undefined ? 0 : outcome.code);
    });
  }
  return child;
}

/** The fake in the shape node:child_process.spawn is declared with. */
export function asSpawn(implementation: (...args: unknown[]) => FakeChild): typeof spawn {
  return implementation as unknown as typeof spawn;
}
