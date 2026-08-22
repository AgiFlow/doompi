import { spawn } from 'node:child_process';
import type { ExitResult, ISpawner, OutputStream, SpawnedProcess, SpawnRequest } from '../../types/spawner';

const SHELL = '/bin/bash';

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
        child.on('close', (code, signal) => handler({ code, signal }));
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
