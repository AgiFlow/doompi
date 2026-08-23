import { spawn } from 'node:child_process';
import type { EngineCaptureResult, EngineProcessRunner, EngineRunOptions } from '../types/sandboxHarness.ts';

const INHERIT = 'inherit';
const PIPE = 'pipe';
const IGNORE = 'ignore';
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Spawns the container engine, keeping the session's terminal attached. */
export class SpawnEngineProcessRunner implements EngineProcessRunner {
  run(command: string, args: string[], options: EngineRunOptions = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: options.input === undefined ? INHERIT : [PIPE, INHERIT, INHERIT],
      });
      if (options.input !== undefined) child.stdin?.end(options.input);

      // With a shared terminal the engine sees Ctrl-C itself; forwarding covers
      // detached automation runs, and a duplicate signal is harmless.
      const forwarders = FORWARDED_SIGNALS.map((signal) => {
        const forward = (): void => {
          child.kill(signal);
        };
        process.on(signal, forward);
        return { signal, forward };
      });
      const cleanup = (): void => {
        for (const { signal, forward } of forwarders) process.off(signal, forward);
      };

      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('exit', (code, signal) => {
        cleanup();
        resolve(code ?? (signal ? 1 : 0));
      });
    });
  }

  capture(command: string, args: string[]): Promise<EngineCaptureResult | undefined> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: [IGNORE, PIPE, IGNORE] });
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.once('error', () => {
        resolve(undefined);
      });
      child.once('exit', (code) => {
        resolve({ exitCode: code ?? 1, stdout });
      });
    });
  }
}
