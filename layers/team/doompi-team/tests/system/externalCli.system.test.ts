import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SUBAGENT_ROOT_SESSION_ENV, SUBAGENT_RUN_ID_ENV } from '../../src/exports/env';
import { fableProfileResultPathFor } from '../../src/adapters/runs/background/asyncExecution';
import { prepareClaudeFableLaunch } from '../../src/adapters/runs/shared/claudeFableProfile';
import {
  createSessionScope,
  getRunConfigPath,
  scopeResultsDir,
  scopeRunsDir,
  sessionScopeDir,
  sessionScopeEnvironment,
} from '../../src/adapters/filesystem/paths';

const runnerEntry = path.resolve('dist/runs/background/cliRunnerEntry.mjs');
const cleanup: string[] = [];

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function startExternal(args: string[]) {
  const rootSessionId = `external-${randomUUID()}`;
  const scope = createSessionScope(rootSessionId);
  cleanup.push(sessionScopeDir(scope));
  const runId = randomUUID();
  const runDir = path.join(scopeRunsDir(scope), runId);
  const handshakePath = path.join(runDir, 'handshake.json');
  const resultPath = path.join(scopeResultsDir(scope), `${runId}.json`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-external-'));
  cleanup.push(cwd);
  fs.mkdirSync(runDir, { recursive: true });
  const configPath = getRunConfigPath(scope, runId);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      runId,
      agent: 'external-worker',
      runtime: 'fake-cli',
      command: process.execPath,
      args,
      cwd,
      env: {},
      handshakePath,
      resultPath,
    }),
  );
  const child = spawn(process.execPath, [runnerEntry], {
    cwd,
    env: {
      ...process.env,
      ...sessionScopeEnvironment(scope),
      [SUBAGENT_RUN_ID_ENV]: runId,
      [SUBAGENT_ROOT_SESSION_ENV]: rootSessionId,
    },
    stdio: 'ignore',
  });
  return { child, handshakePath, resultPath, statusPath: path.join(runDir, 'status.json') };
}

function startFableExternal() {
  const rootSessionId = `fable-${randomUUID()}`;
  const scope = createSessionScope(rootSessionId);
  cleanup.push(sessionScopeDir(scope));
  const runId = randomUUID();
  const runDir = path.join(scopeRunsDir(scope), runId);
  const handshakePath = path.join(runDir, 'handshake.json');
  const resultPath = path.join(scopeResultsDir(scope), `${runId}.json`);
  const profileResultPath = fableProfileResultPathFor(runId);
  const recordPath = path.join(runDir, 'vendor-record.json');
  const fakeClaude = path.join(runDir, 'fake-claude.mjs');
  const repositoryCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-fable-repository-'));
  cleanup.push(repositoryCwd);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
import fs from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, stdin }));
process.stdout.write(JSON.stringify({ type: 'result', result: 'SECURE_FABLE_OK' }) + '\\n');
`,
    { mode: 0o700 },
  );
  const prompt = 'UNTRUSTED_EVIDENCE_PACKET_7f9b';
  const launch = prepareClaudeFableLaunch({
    runId,
    prompt,
    repositoryCwd,
    privateRoot: runDir,
    environment: {
      HOME: os.homedir(),
      PATH: process.env.PATH,
      LANG: 'en_US.UTF-8',
      DOOM_TEAM_CLAUDE_BIN: fakeClaude,
      DOOM_TEAM_MEMBER_TOKEN: 'must-not-pass',
      ANTHROPIC_API_KEY: 'must-not-pass',
      OTEL_EXPORTER_OTLP_HEADERS: 'must-not-pass',
      PI_SESSION_FILE: '/secret/session.jsonl',
      PROJECT_CWD: '/repository',
    },
  });
  const configPath = getRunConfigPath(scope, runId);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      runId,
      operationId: 'operation-system-test',
      agent: 'fable-draft',
      runtime: 'claude',
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      profile: launch.profile,
      stdinPath: launch.stdinPath,
      cleanupPaths: launch.cleanupPaths,
      profileResultPath,
      internal: true,
      handshakePath,
      resultPath,
    }),
  );
  const child = spawn(process.execPath, [runnerEntry], {
    cwd: runDir,
    env: {
      ...process.env,
      ...sessionScopeEnvironment(scope),
      [SUBAGENT_RUN_ID_ENV]: runId,
      [SUBAGENT_ROOT_SESSION_ENV]: rootSessionId,
    },
    stdio: 'ignore',
  });
  return {
    child,
    handshakePath,
    resultPath,
    profileResultPath,
    recordPath,
    repositoryCwd: launch.cwd,
    privateSandbox: path.dirname(launch.stdinPath),
    prompt,
    statusPath: path.join(runDir, 'status.json'),
  };
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe('external CLI lifecycle', () => {
  it('persists completed status before reporting transport success', async () => {
    const run = startExternal(['-e', 'process.stdout.write("EXTERNAL_OK")']);
    await waitForFile(run.handshakePath);
    expect(await waitForExit(run.child)).toBe(0);

    const status = JSON.parse(fs.readFileSync(run.statusPath, 'utf8')) as Record<string, unknown>;
    const result = JSON.parse(fs.readFileSync(run.resultPath, 'utf8')) as Record<string, unknown>;
    expect(status).toMatchObject({ state: 'completed', runtime: 'fake-cli', summary: 'EXTERNAL_OK' });
    expect(result).toMatchObject({ success: true, runtime: 'fake-cli', summary: 'EXTERNAL_OK' });
  });

  it('terminates the vendor process and persists stopped status', async () => {
    const run = startExternal(['-e', 'setInterval(() => {}, 1000)']);
    await waitForFile(run.handshakePath);
    run.child.kill('SIGTERM');
    expect(await waitForExit(run.child)).toBe(0);

    const status = JSON.parse(fs.readFileSync(run.statusPath, 'utf8')) as Record<string, unknown>;
    expect(status).toMatchObject({ state: 'stopped', runtime: 'fake-cli' });
  });

  it('runs the trusted Fable profile through stdin with fixed isolation and cleanup', async () => {
    const run = startFableExternal();
    await waitForFile(run.handshakePath);
    expect(await waitForExit(run.child)).toBe(0);

    const record = JSON.parse(fs.readFileSync(run.recordPath, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      stdin: string;
    };
    const statusText = fs.readFileSync(run.statusPath, 'utf8');
    const resultText = fs.readFileSync(run.resultPath, 'utf8');
    const profileResult = JSON.parse(fs.readFileSync(run.profileResultPath, 'utf8')) as { text: string };
    expect(record.argv).toEqual(
      expect.arrayContaining([
        '--print',
        '--max-turns',
        '60',
        '--output-format',
        'stream-json',
        '--model',
        'fable',
        '--strict-mcp-config',
        '--disallowedTools',
      ]),
    );
    expect(record.argv.join(' ')).not.toContain(run.prompt);
    expect(record.stdin).toContain(run.prompt);
    expect(record.cwd).toBe(run.repositoryCwd);
    expect(record.env).toMatchObject({ HOME: os.homedir(), PATH: process.env.PATH });
    for (const name of [
      'DOOM_TEAM_CLAUDE_BIN',
      'DOOM_TEAM_MEMBER_TOKEN',
      'ANTHROPIC_API_KEY',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'PI_SESSION_FILE',
      'PROJECT_CWD',
    ]) {
      expect(record.env[name]).toBeUndefined();
    }
    expect(profileResult).toEqual({ text: 'SECURE_FABLE_OK', outputBytes: 45 });
    expect(statusText).not.toContain(run.prompt);
    expect(resultText).not.toContain(run.prompt);
    expect(fs.existsSync(run.privateSandbox)).toBe(false);
    expect(fs.existsSync(run.repositoryCwd)).toBe(true);
  });
});
