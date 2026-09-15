import { spawn } from 'node:child_process';

import { EXIT_OUTPUT_DRAIN_MS, SHELL } from '../../constants/spawner';
import type { ExitResult, ISpawner, OutputStream, SpawnedProcess, SpawnRequest } from '../../types/spawner';

/** Wraps `node:child_process.spawn`. */
export class NodeSpawner implements ISpawner {
  spawn(request: SpawnRequest): SpawnedProcess {
    const child = spawn(request.command, {
      cwd: request.cwd,
      env: request.env,
      detached: request.detached,
      shell: SHELL,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    return {
      pid: child.pid,
      onOutput(handler: (chunk: string, stream: OutputStream) => void): void {
        child.stdout?.on('data', (chunk: string) => handler(chunk, 'stdout'));
        child.stderr?.on('data', (chunk: string) => handler(chunk, 'stderr'));
      },
      onExit(handler: (result: ExitResult) => void): void {
        let finished = false;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: ExitResult): void => {
          if (finished) return;
          finished = true;
          if (drainTimer) clearTimeout(drainTimer);
          handler(result);
        };
        child.once('exit', (code, signal) => {
          // Descendants can keep inherited stdout/stderr open after the
          // supervised command exits. `close` would then wait for them too.
          drainTimer = setTimeout(() => finish({ code, signal }), EXIT_OUTPUT_DRAIN_MS);
        });
        child.once('close', (code, signal) => finish({ code, signal }));
      },
      onError(handler: (error: Error) => void): void {
        child.on('error', handler);
      },
      kill(signal?: NodeJS.Signals): void {
        child.kill(signal);
      },
      unref(): void {
        child.unref();
      },
    };
  }
}
