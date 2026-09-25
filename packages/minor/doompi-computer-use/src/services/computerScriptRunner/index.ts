import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type {
  ComputerScriptExecutionOptions,
  ComputerScriptExecutionResult,
  ComputerScriptRunnerOptions,
} from '../../types/computerScript';
import type { ComputerUseAction, ComputerUseObservation, ComputerUseSessionClient } from '../../types/computerUse';
import { COMPUTER_SCRIPT_WORKER_SOURCE } from '../computerScriptWorker';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_PENDING_OPERATIONS = 64;

export class ComputerScriptExecutionError extends Error {
  constructor(
    message: string,
    readonly completedActions: number,
    readonly outcomeUncertain: boolean,
  ) {
    super(message);
    this.name = 'ComputerScriptExecutionError';
  }
}

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
  private readonly scriptRoot?: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: ComputerScriptRunnerOptions) {
    this.client = options.client;
    this.allowedScriptPaths = options.allowedScriptPaths;
    this.scriptRoot = options.scriptRoot;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async execute(
    scriptPath: string,
    input: unknown,
    signal?: AbortSignal,
    options: ComputerScriptExecutionOptions = {},
    cwd?: string,
  ): Promise<ComputerScriptExecutionResult> {
    signal?.throwIfAborted();
    const resolvedPath = await realpath(path.resolve(this.scriptRoot ?? cwd ?? process.cwd(), scriptPath));
    const allowedPaths = await Promise.all(
      this.allowedScriptPaths.map(async (candidate) => realpath(candidate).catch(() => '')),
    );
    const trusted = options.trusted === true;
    if ((trusted || this.scriptRoot === undefined) && !allowedPaths.includes(resolvedPath)) {
      throw new Error('Computer script path is not explicitly allowed.');
    }
    if (!/\.(ts|js|mjs)$/u.test(resolvedPath))
      throw new Error('Computer scripts must be JavaScript or erasable TypeScript files.');
    const root = await realpath(this.scriptRoot ?? path.dirname(resolvedPath));
    const relative = path.relative(root, resolvedPath);
    if (!trusted && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
      throw new Error('Computer script escapes the admitted script root.');
    }
    const serializedInput = JSON.stringify(input);
    if (serializedInput === undefined) throw new Error('Computer script input must be JSON serializable.');
    if (Buffer.byteLength(serializedInput) > this.maxOutputBytes)
      throw new Error('Computer script input exceeds the size limit.');
    const quickjsPath = trusted ? undefined : createRequire(import.meta.url).resolve('quickjs-emscripten');
    signal?.throwIfAborted();
    const started = performance.now();

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', COMPUTER_SCRIPT_WORKER_SOURCE], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // Preserve Electron's Node mode, but no host credentials, for restricted workers.
        env: trusted ? process.env : { ELECTRON_RUN_AS_NODE: '1' },
      });
      const controller = new AbortController();
      const logs: string[] = [];
      let outputBytes = 0;
      let completedActions = 0;
      let observations = 0;
      let actionInFlight = false;
      let settled = false;
      let completing = false;
      let outstanding = 0;
      let operation: Promise<void> = Promise.resolve();
      const finish = (error?: Error, value?: ComputerScriptExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        controller.abort();
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
        killTimer.unref();
        if (error) reject(new ComputerScriptExecutionError(error.message, completedActions, actionInFlight));
        else resolve(value!);
      };
      const addOutput = (value: string): boolean => {
        outputBytes += Buffer.byteLength(value);
        if (outputBytes <= this.maxOutputBytes) return true;
        finish(new Error('Computer script output exceeded the size limit.'));
        return false;
      };
      const send = (value: object): void => {
        if (settled || !child.connected) return;
        child.send(value, (error) => {
          if (error && !settled) finish(error);
        });
      };
      const onAbort = (): void => finish(new Error('Computer script execution was cancelled.'));
      const timeout = setTimeout(() => finish(new Error('Computer script execution timed out.')), this.timeoutMs);
      timeout.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      child.stdout?.on('data', (chunk: Buffer) => addOutput(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => addOutput(chunk.toString('utf8')));
      child.on('error', (error) => finish(error));
      child.on('exit', (code, exitSignal) => {
        if (!settled)
          finish(new Error(`Computer script worker exited before completion (${exitSignal ?? code ?? 'unknown'}).`));
      });

      const observe = async (includeScreenshot: boolean): Promise<ComputerUseObservation> => {
        const value = await this.client.observe(controller.signal, { includeScreenshot });
        observations += 1;
        const { screenshot, ...semantic } = value;
        if (Buffer.byteLength(JSON.stringify(semantic)) > this.maxOutputBytes)
          throw new Error('Computer observation exceeds the size limit.');
        if (includeScreenshot && screenshot) {
          if (screenshot.mimeType !== 'image/png' || screenshot.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
            throw new Error('Computer screenshot exceeds the image limit.');
          }
          return { ...semantic, screenshot };
        }
        return semantic;
      };

      child.on('message', (raw: WorkerMessage) => {
        if (settled) return;
        if (!raw || typeof raw !== 'object' || Buffer.byteLength(JSON.stringify(raw)) > this.maxOutputBytes + 4096) {
          finish(new Error('Computer worker message exceeds the size limit.'));
          return;
        }
        if (raw.type === 'log' && typeof raw.message === 'string') {
          const line = `[${String(raw.level)}] ${raw.message}`;
          if (addOutput(line)) logs.push(line);
          return;
        }
        if (raw.type === 'program') {
          if (
            completing ||
            typeof raw.id !== 'string' ||
            raw.id.length > 128 ||
            (raw.operation !== 'observe' && raw.operation !== 'act') ||
            outstanding >= MAX_PENDING_OPERATIONS
          ) {
            finish(new Error('Invalid or excessive computer program operations.'));
            return;
          }
          outstanding += 1;
          operation = operation
            .then(async () => {
              if (settled || controller.signal.aborted) return;
              try {
                let value: unknown;
                if (raw.operation === 'observe') {
                  const settings = raw.payload;
                  if (
                    !settings ||
                    typeof settings !== 'object' ||
                    Array.isArray(settings) ||
                    Object.keys(settings).some((key) => key !== 'includeScreenshot') ||
                    ('includeScreenshot' in settings && typeof settings.includeScreenshot !== 'boolean')
                  ) {
                    throw new Error('Invalid observation options.');
                  }
                  value = await observe('includeScreenshot' in settings && settings.includeScreenshot === true);
                } else {
                  actionInFlight = true;
                  value = await this.client.act(raw.payload as ComputerUseAction, controller.signal);
                  completedActions += 1;
                  actionInFlight = false;
                }
                send({ type: 'response', id: raw.id, value });
              } catch (error) {
                // An action can have taken effect before its transport failed. Never run the remaining chain.
                if (actionInFlight) finish(error instanceof Error ? error : new Error(String(error)));
                else
                  send({ type: 'response', id: raw.id, error: error instanceof Error ? error.message : String(error) });
              } finally {
                outstanding -= 1;
              }
            })
            .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        if (raw.type === 'failed' && typeof raw.error === 'string') {
          finish(new Error(raw.error));
          return;
        }
        if (raw.type === 'complete') {
          if (completing) {
            finish(new Error('Computer worker completed twice.'));
            return;
          }
          completing = true;
          operation = operation
            .then(async () => {
              if (settled) return;
              const resultJson = raw.resultJson;
              if (resultJson !== undefined && typeof resultJson !== 'string')
                throw new Error('Computer script returned an invalid result.');
              if (typeof resultJson === 'string' && !addOutput(resultJson)) return;
              const observation = await observe(options.includeScreenshot === true);
              if (settled || !addOutput(JSON.stringify({ ...observation, screenshot: undefined }))) return;
              finish(undefined, {
                ...(typeof resultJson === 'string' ? { result: JSON.parse(resultJson) as unknown } : {}),
                observation,
                logs,
                metrics: {
                  actions: completedActions,
                  observations,
                  durationMs: Math.round(performance.now() - started),
                  outputBytes,
                },
              });
            })
            .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
        }
      });
      send({
        type: 'start',
        scriptPath: resolvedPath,
        scriptRoot: root,
        input: JSON.parse(serializedInput) as unknown,
        trusted,
        quickjsPath,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      });
    });
  }
}
