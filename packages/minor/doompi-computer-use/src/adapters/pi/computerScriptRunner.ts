import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { ComputerScriptExecutionResult, ComputerScriptRunnerOptions } from '../../types/computerScript.ts';
import type { ComputerUseAction } from '../../types/computerUse.ts';
import type { ComputerUseSessionClient } from './sessionApiClient.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

const WORKER_SOURCE = String.raw`
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

let nextRequestId = 0;
const pending = new Map();
const call = (operation, payload) => new Promise((resolve, reject) => {
  const id = String(++nextRequestId);
  pending.set(id, { resolve, reject });
  process.send({ type: 'program', id, operation, payload });
});
process.on('message', async (message) => {
  if (message?.type === 'response') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
    return;
  }
  if (message?.type !== 'start') return;
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (value) => {
    process.send({ type: 'log', level, message: String(value) });
  }]));
  try {
    const source = await readFile(message.scriptPath, 'utf8');
    const compiled = stripTypeScriptTypes(source, { mode: 'strip' });
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
    const loaded = await import(moduleUrl);
    if (typeof loaded.run !== 'function') throw new Error('Computer script must export a named run function.');
    const program = {
      observe: () => call('observe'),
      act: (action) => call('act', action),
    };
    const result = await loaded.run({ context: { program }, input: message.input, logger, signal: controller.signal });
    const resultJson = result === undefined ? undefined : JSON.stringify(result);
    process.send({ type: 'complete', resultJson });
  } catch (error) {
    process.send({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
});
`;

interface WorkerMessage {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly operation?: unknown;
  readonly payload?: unknown;
  readonly level?: unknown;
  readonly message?: unknown;
  readonly resultJson?: unknown;
  readonly error?: unknown;
}

export class ComputerScriptRunner {
  private readonly client: ComputerUseSessionClient;
  private readonly allowedScriptPaths: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  public constructor(options: ComputerScriptRunnerOptions) {
    this.client = options.client;
    this.allowedScriptPaths = options.allowedScriptPaths;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  public async execute(
    scriptPath: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ComputerScriptExecutionResult> {
    const resolvedPath = await realpath(scriptPath);
    const allowedPaths = await Promise.all(
      this.allowedScriptPaths.map(async (candidate) => realpath(candidate).catch(() => '')),
    );
    if (!allowedPaths.includes(resolvedPath)) throw new Error('Computer script path is not explicitly allowed.');
    if (!resolvedPath.endsWith('.ts')) throw new Error('Computer scripts must be TypeScript files.');

    const serializedInput = JSON.stringify(input);
    if (serializedInput === undefined) throw new Error('Computer script input must be JSON serializable.');
    if (Buffer.byteLength(serializedInput) > this.maxOutputBytes)
      throw new Error('Computer script input exceeds the size limit.');

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', WORKER_SOURCE], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const controller = new AbortController();
      const logs: string[] = [];
      let outputBytes = 0;
      let settled = false;
      let operation = Promise.resolve();

      const terminate = (): void => {
        controller.abort();
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
        killTimer.unref?.();
      };
      const finish = (error?: Error, value?: ComputerScriptExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        terminate();
        if (error !== undefined) reject(error);
        else resolve(value as ComputerScriptExecutionResult);
      };
      const addOutput = (value: string): boolean => {
        outputBytes += Buffer.byteLength(value);
        if (outputBytes <= this.maxOutputBytes) return true;
        finish(new Error('Computer script output exceeded the size limit.'));
        return false;
      };
      const onAbort = () => finish(new Error('Computer script execution was cancelled.'));
      const timeout = setTimeout(() => finish(new Error('Computer script execution timed out.')), this.timeoutMs);
      timeout.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) return onAbort();

      child.stdout?.on('data', (chunk: Buffer) => addOutput(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => addOutput(chunk.toString('utf8')));
      child.on('error', (error) => finish(error));
      child.on('exit', (code, exitSignal) => {
        if (!settled)
          finish(new Error(`Computer script worker exited before completion (${exitSignal ?? code ?? 'unknown'}).`));
      });
      child.on('message', (rawMessage: WorkerMessage) => {
        if (settled) return;
        if (rawMessage.type === 'log' && typeof rawMessage.message === 'string') {
          const line = `[${String(rawMessage.level)}] ${rawMessage.message}`;
          if (addOutput(line)) logs.push(line);
          return;
        }
        if (
          rawMessage.type === 'program' &&
          typeof rawMessage.id === 'string' &&
          (rawMessage.operation === 'observe' || rawMessage.operation === 'act')
        ) {
          operation = operation.then(async () => {
            try {
              const value =
                rawMessage.operation === 'observe'
                  ? await this.client.observe(controller.signal)
                  : await this.client.act(rawMessage.payload as ComputerUseAction, controller.signal);
              child.send({ type: 'response', id: rawMessage.id, value });
            } catch (error) {
              child.send({
                type: 'response',
                id: rawMessage.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
          return;
        }
        if (rawMessage.type === 'failed' && typeof rawMessage.error === 'string') {
          finish(new Error(rawMessage.error));
          return;
        }
        if (rawMessage.type === 'complete') {
          operation = operation
            .then(async () => {
              const resultJson = rawMessage.resultJson;
              if (resultJson !== undefined && typeof resultJson !== 'string') {
                finish(new Error('Computer script returned an invalid result.'));
                return;
              }
              if (typeof resultJson === 'string' && !addOutput(resultJson)) return;
              const observation = await this.client.observe(controller.signal);
              finish(undefined, {
                ...(typeof resultJson === 'string' ? { result: JSON.parse(resultJson) as unknown } : {}),
                observation,
                logs,
              });
            })
            .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
        }
      });
      child.send({ type: 'start', scriptPath: resolvedPath, input: JSON.parse(serializedInput) as unknown });
    });
  }
}
