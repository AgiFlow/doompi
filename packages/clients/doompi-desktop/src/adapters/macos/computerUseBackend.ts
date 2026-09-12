import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemPreferences } from 'electron';
import type { ComputerUseBackend, ComputerUseStopResult } from '../../types/computerUse';

const MAX_HELPER_OUTPUT_BYTES = 8 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 15_000;

type HelperResponse = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: string };
type ActiveHelper = {
  readonly sessionId: string;
  readonly grantId: string;
  readonly runId: string;
  readonly activation: unknown;
  readonly authorizationPath: string;
  readonly operations: Set<ChildProcessWithoutNullStreams>;
  readonly process: ChildProcessWithoutNullStreams;
  readonly completion: Promise<void>;
  output: string;
  errors: string;
};

export interface MacOsComputerUseBackendOptions {
  readonly helperPath?: string;
}

function helperPath(override?: string): string {
  return override ?? path.join(process.resourcesPath, 'native', 'doompi-computer-use-helper');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeObservation(value: unknown, active: ActiveHelper): unknown {
  const observation = record(value);
  const target = record(record(active.activation)?.target);
  const screenshot = record(observation?.screenshot);
  if (
    typeof observation?.snapshotId !== 'string' ||
    !Array.isArray(observation.elements) ||
    typeof target?.applicationName !== 'string' ||
    typeof target.bundleId !== 'string' ||
    typeof target.windowId !== 'string' ||
    typeof target.windowTitle !== 'string' ||
    typeof screenshot?.data !== 'string' ||
    screenshot.mimeType !== 'image/png'
  )
    throw new Error('The macOS helper returned an invalid observation.');
  return {
    runId: active.runId,
    snapshotId: observation.snapshotId,
    targetGeneration: `${String(target.processId)}:${target.windowId}`,
    applicationName: target.applicationName,
    bundleId: target.bundleId,
    windowTitle: target.windowTitle,
    elements: observation.elements,
    screenshot: { mimeType: 'image/png', data: screenshot.data },
    ...(observation.truncated === true ? { truncated: true } : {}),
  };
}
function decodeResponse(output: string): unknown {
  const response = JSON.parse(output) as HelperResponse;
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

function verifiedProbe(value: unknown): unknown {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { protocolVersion?: unknown }).protocolVersion !== 1 ||
    (value as { architecture?: unknown }).architecture !== 'arm64'
  )
    throw new Error('The macOS helper capability probe is incompatible.');
  return value;
}

function stopResult(value: unknown): ComputerUseStopResult {
  if (typeof value !== 'object' || value === null || (value as { stopped?: unknown }).stopped !== true)
    throw new Error('The macOS helper returned an invalid stop result.');
  const artifact = (value as { artifact?: Record<string, unknown> }).artifact;
  if (
    artifact === undefined ||
    artifact.kind !== 'screen_recording' ||
    typeof artifact.path !== 'string' ||
    artifact.path === '' ||
    artifact.contentType !== 'video/mp4' ||
    artifact.audioScope !== 'target_application'
  )
    throw new Error('The macOS helper returned an invalid recording artifact.');
  return {
    stopped: true,
    artifact: {
      kind: 'screen_recording',
      path: artifact.path,
      contentType: 'video/mp4',
      audioScope: 'target_application',
    },
  };
}
function runHelper(
  executable: string,
  operation: string,
  payload: unknown,
  signal?: AbortSignal,
  processes?: Set<ChildProcessWithoutNullStreams>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [operation], { stdio: ['pipe', 'pipe', 'pipe'] });
    processes?.add(child);
    let output = '';
    let errors = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      processes?.delete(child);
      callback();
    };
    const timeout = setTimeout(() => child.kill('SIGKILL'), HELPER_TIMEOUT_MS);
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > MAX_HELPER_OUTPUT_BYTES) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: string) => (errors += chunk));
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code) => {
      finish(() => {
        if (signal?.aborted === true) reject(new Error('The macOS helper request was cancelled.'));
        else if (code !== 0) reject(new Error(errors || `The macOS helper exited with code ${String(code)}.`));
        else {
          try {
            resolve(decodeResponse(output));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    child.stdin.end(JSON.stringify(payload ?? {}));
    if (signal?.aborted === true) abort();
  });
}

export function createMacOsComputerUseBackend(options: MacOsComputerUseBackendOptions = {}): ComputerUseBackend {
  const executable = helperPath(options.helperPath);
  let active: ActiveHelper | undefined;

  return {
    async status() {
      const permissions = {
        accessibility: systemPreferences.isTrustedAccessibilityClient(false),
        screenRecording: systemPreferences.getMediaAccessStatus('screen'),
      };
      try {
        const probe = verifiedProbe(await runHelper(executable, 'probe', {}));
        return { platform: process.platform, ...permissions, nativeAdapter: 'available', probe };
      } catch (error) {
        return {
          platform: process.platform,
          ...permissions,
          nativeAdapter: 'unavailable',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async targets() {
      return await runHelper(executable, 'targets', {});
    },
    async activate(input) {
      if (active !== undefined) throw new Error('The macOS computer-use helper is already active.');
      const authorizationPath = path.join(os.tmpdir(), `doompi-computer-use-${randomUUID()}.grant`);
      fs.writeFileSync(authorizationPath, input.grantId, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const child = spawn(executable, ['record'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let complete: (() => void) | undefined;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const recording: ActiveHelper = {
        sessionId: input.sessionId,
        grantId: input.grantId,
        runId: input.runId,
        activation: input.payload,
        authorizationPath,
        operations: new Set(),
        process: child,
        completion,
        output: '',
        errors: '',
      };
      active = recording;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        recording.output += chunk;
        if (Buffer.byteLength(recording.output) > MAX_HELPER_OUTPUT_BYTES) child.kill('SIGKILL');
      });
      child.stderr.on('data', (chunk: string) => {
        recording.errors += chunk;
        if (Buffer.byteLength(recording.errors) > MAX_HELPER_OUTPUT_BYTES) child.kill('SIGKILL');
      });
      child.once('exit', () => complete?.());
      child.once('error', () => complete?.());
      const activation = {
        grantId: input.grantId,
        runId: input.runId,
        expiresAt: input.expiresAt,
        payload: input.payload,
      };
      child.stdin.end(JSON.stringify(activation));
      try {
        return await new Promise((resolve, reject) => {
          const abort = () => child.kill('SIGTERM');
          const onData = () => {
            const newline = recording.output.indexOf('\n');
            if (newline < 0) return;
            cleanup();
            try {
              resolve(decodeResponse(recording.output.slice(0, newline)));
            } catch (error) {
              reject(error);
            }
          };
          const onExit = (code: number | null) => {
            cleanup();
            reject(
              new Error(
                recording.errors || `The macOS recording helper exited with code ${String(code)} before starting.`,
              ),
            );
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const cleanup = () => {
            input.signal?.removeEventListener('abort', abort);
            child.stdout.off('data', onData);
            child.off('exit', onExit);
            child.off('error', onError);
          };
          input.signal?.addEventListener('abort', abort, { once: true });
          child.stdout.on('data', onData);
          child.once('exit', onExit);
          child.once('error', onError);
          if (input.signal?.aborted === true) abort();
          onData();
        });
      } catch (error) {
        if (active === recording) active = undefined;
        fs.rmSync(authorizationPath, { force: true });
        child.kill('SIGTERM');
        throw error;
      }
    },
    async observe(input) {
      const recording = active;
      if (recording === undefined || recording.sessionId !== input.sessionId || recording.grantId !== input.grantId)
        throw new Error('The macOS computer-use helper is not active for this grant.');
      const observation = await runHelper(
        executable,
        'observe',
        { activation: recording.activation, authorizationPath: recording.authorizationPath, request: input.payload },
        input.signal,
        recording.operations,
      );
      return normalizeObservation(observation, recording);
    },
    async act(input) {
      const recording = active;
      if (recording === undefined || recording.sessionId !== input.sessionId || recording.grantId !== input.grantId)
        throw new Error('The macOS computer-use helper is not active for this grant.');
      return await runHelper(
        executable,
        'act',
        { activation: recording.activation, authorizationPath: recording.authorizationPath, request: input.payload },
        input.signal,
        recording.operations,
      );
    },
    async stop(input): Promise<ComputerUseStopResult> {
      const recording = active;
      if (recording === undefined || recording.sessionId !== input.sessionId || recording.grantId !== input.grantId)
        return { stopped: false };
      active = undefined;
      fs.rmSync(recording.authorizationPath, { force: true });
      for (const operation of recording.operations) if (operation.exitCode === null) operation.kill('SIGKILL');
      if (recording.process.exitCode === null) recording.process.kill('SIGINT');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          recording.completion,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              recording.process.kill('SIGKILL');
              reject(new Error('The macOS helper did not stop in time.'));
            }, HELPER_TIMEOUT_MS);
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      try {
        const lines = recording.output.trim().split('\n');
        return stopResult(decodeResponse(lines.at(-1) ?? ''));
      } catch (error) {
        throw new Error(recording.errors || (error instanceof Error ? error.message : String(error)));
      }
    },
  };
}
