import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SUBAGENT_ROOT_SESSION_ENV, SUBAGENT_RUN_ID_ENV } from '../../src/exports/env';
import { createSessionScope, scopeResultsDir, sessionScopeDir } from '../../src/services/sessionPaths';
import {
  makeExternalControlMessage,
  makeExternalLaunchMessage,
  parseExternalRunnerMessage,
  type ExternalRunnerMessage,
} from '../../src/services/externalProcessIpc';

const runnerEntry = path.resolve('dist/runs/background/cliRunnerEntry.mjs');
const cleanup: string[] = [];

function send(child: ChildProcess, message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

function waitForMessage(child: ChildProcess, kind: ExternalRunnerMessage['kind']): Promise<ExternalRunnerMessage> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      child.off('message', onMessage);
      reject(error);
    };
    const onMessage = (raw: unknown): void => {
      const message = parseExternalRunnerMessage(raw);
      if (!message || message.kind !== kind) return;
      child.off('error', onError);
      child.off('message', onMessage);
      resolve(message);
    };
    child.on('error', onError);
    child.on('message', onMessage);
  });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

function startExternal(args: string[]) {
  const scope = createSessionScope(`external-${randomUUID()}`);
  cleanup.push(sessionScopeDir(scope));
  const runId = randomUUID();
  const resultPath = path.join(scopeResultsDir(scope), `${runId}.json`);
  const child = spawn(process.execPath, [runnerEntry], {
    env: {
      ...process.env,
      [SUBAGENT_RUN_ID_ENV]: runId,
      [SUBAGENT_ROOT_SESSION_ENV]: scope.rootSessionId,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const config = {
    runId,
    agent: 'external-worker',
    task: 'run the external fixture',
    sensitiveTask: false,
    runtime: 'fake-cli',
    command: process.execPath,
    args,
    cwd: process.cwd(),
    env: {},
    resultPath,
    internal: false,
  };
  return { child, scope, runId, resultPath, config };
}

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe('external CLI lifecycle over Node IPC', () => {
  it('delivers readiness and completion without a filesystem handshake', async () => {
    const run = startExternal(['-e', 'process.stdout.write("EXTERNAL_OK")']);
    const ready = waitForMessage(run.child, 'ready');
    const result = waitForMessage(run.child, 'result');
    await send(run.child, makeExternalLaunchMessage(run.scope, run.runId, run.config));

    await expect(ready).resolves.toMatchObject({ kind: 'ready', runId: run.runId });
    await expect(result).resolves.toMatchObject({
      kind: 'result',
      result: { success: true, runtime: 'fake-cli', summary: 'EXTERNAL_OK' },
    });
    expect(await waitForExit(run.child)).toBe(0);
    expect(JSON.parse(fs.readFileSync(run.resultPath, 'utf8'))).toMatchObject({
      success: true,
      summary: 'EXTERNAL_OK',
    });
  });

  it('stops the vendor process through the same IPC channel', async () => {
    const run = startExternal(['-e', 'setInterval(() => {}, 1000)']);
    const ready = waitForMessage(run.child, 'ready');
    await send(run.child, makeExternalLaunchMessage(run.scope, run.runId, run.config));
    await ready;

    const result = waitForMessage(run.child, 'result');
    await send(
      run.child,
      makeExternalControlMessage(run.scope, run.runId, {
        command: 'stop',
        requestId: randomUUID(),
        reason: 'system test complete',
      }),
    );
    await expect(result).resolves.toMatchObject({ kind: 'result', result: { success: false, state: 'stopped' } });
    expect(await waitForExit(run.child)).toBe(0);
  });
});
