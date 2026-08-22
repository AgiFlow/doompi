import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { requestAsyncStop } from '../../src/adapters/intercom/supervisorControlChannel';

interface RpcRecord {
  type?: string;
  id?: string;
  success?: boolean;
  [key: string]: unknown;
}

interface RunStatus {
  activityState?: string;
  agent?: string;
  error?: string;
  reason?: string;
  runId?: string;
  state?: string;
  summary?: string;
  sessionFile?: string;
  transcriptPath?: string;
  nestedRoute?: { rootRunId?: string; eventSink?: string; controlInbox?: string };
}

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceDir = path.resolve(packageDir, '../../..');
const piCli = path.join(packageDir, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const doomPiCli = path.join(workspaceDir, 'packages/core/doompi/dist/bin/cli.mjs');
const extensionPath = path.join(packageDir, 'dist/extensions/pi.mjs');
const providerImplementationPath = path.join(packageDir, 'tests/system/fixtures/scriptedProvider.cts');
const providerPath = path.join(os.tmpdir(), `doom-team-scripted-provider-${process.pid}.cts`);
const consumerGuardrailFile = 'consumer-guardrail.mjs';
const vibeLintExtensionPath = path.join(workspaceDir, 'node_modules/@agimon-ai/vibe-lint/dist/extensions/pi.mjs');
const explicitSkillName = 'explicit-system-skill';
const explicitSkillDescription = 'Explicit system skill metadata description';
const explicitSkillBody = 'EXPLICIT_SKILL_BODY_E2E_OK';
const ambientSkillName = 'ambient-system-skill';
const processShutdownTimeoutMs = 5_000;
const guardrailTestTimeoutMs = 75_000;
const tempRoot = path.join(os.tmpdir(), `doom-team-uid-${process.getuid?.() ?? 'shared'}`);
const sessionsDir = path.join(tempRoot, 'sessions');

function runEntries(): Array<{ runId: string; runDir: string }> {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir).flatMap((session) => {
    const runsDir = path.join(sessionsDir, session, 'runs');
    if (!fs.existsSync(runsDir)) return [];
    return fs.readdirSync(runsDir).map((runId) => ({ runId, runDir: path.join(runsDir, runId) }));
  });
}

function statusPathFor(runId: string): string {
  const entry = runEntries().find((candidate) => candidate.runId === runId);
  return path.join(entry?.runDir ?? path.join(sessionsDir, '__missing__', 'runs', runId), 'status.json');
}

function readRunStatus(statusPath: string): RunStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8')) as RunStatus;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function currentRunIds(): Set<string> {
  return new Set(runEntries().map((entry) => entry.runId));
}
const children: ChildProcessWithoutNullStreams[] = [];

function transcriptFor(status: RunStatus): string | undefined {
  return status.transcriptPath ?? status.sessionFile;
}
const tempDirs: string[] = [];

function spawnedOutcome(value: unknown): { pid: number; runId: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.pid === 'number' && typeof record.runId === 'string') {
      return { pid: record.pid, runId: record.runId };
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const outcome = spawnedOutcome(child);
    if (outcome) return outcome;
  }
  return undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} remained alive past its ${timeoutMs}ms shutdown budget.`);
}

async function stopRpcProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) throw new Error('Cannot stop a spawned Pi RPC process without a pid.');

  child.kill('SIGTERM');
  try {
    await waitForProcessExit(pid, processShutdownTimeoutMs);
    return;
  } catch (terminationError) {
    if (processExists(pid)) child.kill('SIGKILL');
    try {
      await waitForProcessExit(pid, processShutdownTimeoutMs);
    } catch (killError) {
      throw new Error(`Pi RPC process ${pid} did not exit after SIGTERM and SIGKILL.`, {
        cause: killError instanceof Error ? killError : terminationError,
      });
    }
  }
}

async function waitForRunState(runId: string, expectedState: string, timeoutMs = 5_000): Promise<RunStatus> {
  const statusPath = statusPathFor(runId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readRunStatus(statusPath);
    if (status?.state === expectedState) return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run '${runId}' to reach '${expectedState}'.`);
}

function writeAgent(agentDir: string): void {
  const agentsDir = path.join(agentDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'system-worker.md'),
    [
      '---',
      'name: system-worker',
      'description: Deterministic system-test child',
      'model: scripted/system-test',
      'tools: system_pause',
      `extensions: ${providerPath}`,
      'inheritProjectContext: false',
      'inheritSkills: false',
      '---',
      'Return the requested sentinel exactly.',
      '',
    ].join('\n'),
  );
}

function writeExplicitSkillAgent(agentDir: string, requestRoot: string): string {
  const agentsDir = path.join(agentDir, 'agents');
  const configuredSkillDir = path.join(requestRoot, 'configured-skills', explicitSkillName);
  const ambientSkillDir = path.join(agentDir, 'skills', ambientSkillName);
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(configuredSkillDir, { recursive: true });
  fs.mkdirSync(ambientSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, 'system-worker.md'),
    [
      '---',
      'name: system-worker',
      'description: Deterministic explicit-skill child',
      'model: scripted/system-test',
      'tools: read',
      `extensions: ${providerPath}`,
      'inheritProjectContext: false',
      'inheritSkills: false',
      `skills: ${explicitSkillName}`,
      'skillPath: ./configured-skills',
      '---',
      'Load the configured skill and report deterministic evidence.',
      '',
    ].join('\n'),
  );
  const configuredSkillPath = path.join(configuredSkillDir, 'SKILL.md');
  fs.writeFileSync(
    configuredSkillPath,
    [
      '---',
      `name: ${explicitSkillName}`,
      `description: ${explicitSkillDescription}`,
      '---',
      '',
      explicitSkillBody,
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(ambientSkillDir, 'SKILL.md'),
    ['---', `name: ${ambientSkillName}`, 'description: Must remain ambient-only', '---', '', 'AMBIENT_BODY', ''].join(
      '\n',
    ),
  );
  return configuredSkillPath;
}

function cleanHarnessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('DOOMPI_') || key.startsWith('PI_SUBAGENT_') || key.startsWith('AGENT_HARNESS_')) {
      delete environment[key];
    }
  }
  Object.assign(environment, overrides);
  if (environment.PI_SUBAGENT_PARENT_DEPTH?.trim() === '') delete environment.PI_SUBAGENT_PARENT_DEPTH;
  return environment;
}

/**
 * Starts a real Pi RPC process for one test.
 *
 * `requestCwd` is required rather than defaulting to the workspace. Pi reads
 * project settings from its working directory, so defaulting to the repository
 * made every test load this repository's synced `.pi/settings.json`, compose
 * Doom Team a second time through the Doompi entry, and fail on a tool conflict
 * between the two registrations. Pass the test's own temporary directory.
 */
function startRpc(
  agentDir: string,
  environment: NodeJS.ProcessEnv,
  requestCwd: string,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    [
      piCli,
      '--mode',
      'rpc',
      '--no-session',
      '--approve',
      '--provider',
      'scripted',
      '--model',
      'scripted/system-test',
      '--extension',
      providerPath,
      '--extension',
      extensionPath,
    ],
    {
      cwd: requestCwd,
      env: {
        ...cleanHarnessEnvironment(environment),
        PI_CODING_AGENT_DIR: agentDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  return child;
}

function writeDoomPiRepository(root: string): void {
  const doomDir = path.join(root, '.doom');
  const pluginDir = path.join(root, 'plugins', 'system');
  const personaDir = path.join(root, 'agents', 'system-persona');
  const guardrailExtensionPath = path.join(root, consumerGuardrailFile);
  const layerExtensionPath = path.join(root, 'layer-marker.mjs');
  fs.mkdirSync(path.join(pluginDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'skills', 'doom-team-system-skill'), { recursive: true });
  fs.mkdirSync(personaDir, { recursive: true });
  fs.mkdirSync(doomDir, { recursive: true });
  const teamPackageLink = path.join(root, 'node_modules', '@agimon-ai', 'doompi-team');
  fs.mkdirSync(path.dirname(teamPackageLink), { recursive: true });
  // Exercise this worktree's built extension. Falling through to Pi's managed
  // npm install both tests the published package and corrupts RPC stdout.
  fs.symlinkSync(packageDir, teamPackageLink, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  fs.writeFileSync(path.join(root, 'plugins', 'profiles.json'), '{}\n');
  fs.writeFileSync(path.join(doomDir, 'config.yaml'), 'projectTrust: always\n');
  fs.writeFileSync(
    path.join(doomDir, 'modes.yaml'),
    [
      'layers:',
      '  guardrails:',
      '    hookGroups: [quality]',
      '    extensions:',
      `      - ${JSON.stringify(guardrailExtensionPath)}`,
      '  vibe-lint:',
      '    hookGroups: [quality]',
      '    extensions:',
      `      - ${JSON.stringify(vibeLintExtensionPath)}`,
      '  plan-mode:',
      '    extensions:',
      `      - ${JSON.stringify(layerExtensionPath)}`,
      '    packages:',
      "      - name: '@agimon-ai/doompi-team'",
      '        config:',
      '          excludeTools: [ask_user_question, intercom, subagent]',
      'majorMode:',
      '  system:',
      '    - guardrails',
      '    - vibe-lint',
      '    - plan-mode',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(doomDir, 'domains.yaml'),
    [
      'plugins:',
      '  entries:',
      '    system: plugins/system',
      'domains:',
      '  system:',
      '    plugins: [system]',
      '    sharedSkills: false',
      'aliases: {}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(doomDir, 'profiles.yaml'),
    [
      'profiles:',
      '  system:',
      '    persona: agents/system-persona',
      '    env:',
      '      DOOM_TEAM_SYSTEM_PROFILE_VALUE: PROFILE_ENV_E2E_OK',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(personaDir, 'profile.md'), 'PROFILE_PERSONA_E2E_OK\n');
  fs.writeFileSync(
    path.join(pluginDir, 'skills', 'doom-team-system-skill', 'SKILL.md'),
    [
      '---',
      'name: doom-team-system-skill',
      'description: Doom Team inheritance system-test skill',
      '---',
      '',
      'SYSTEM_SKILL_E2E_OK',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(pluginDir, 'agents', 'system-worker.md'),
    [
      '---',
      'name: system-worker',
      'description: Deterministic DoomPi inheritance child',
      'model: scripted/system-test',
      'tools: read, bash',
      `extensions: ${providerPath}`,
      '---',
      'Report the inherited DoomPi configuration.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    guardrailExtensionPath,
    [
      'export default function consumerGuardrail(pi) {',
      "  pi.on('tool_call', (event) => {",
      "    if (event.toolName !== 'bash' || event.input?.command !== 'yarn --version') return;",
      "    return { block: true, reason: 'Use an Nx target instead of Yarn' };",
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    layerExtensionPath,
    [
      "import fs from 'node:fs';",
      "if (process.env.PI_SUBAGENT_CHILD === '1' && process.env.DOOM_TEAM_SYSTEM_LAYER_MARKER) {",
      "  fs.writeFileSync(process.env.DOOM_TEAM_SYSTEM_LAYER_MARKER, 'LAYER_EXTENSION_E2E_OK\\n');",
      '}',
      'export default function layerMarker(pi) {',
      "  if (process.env.PI_SUBAGENT_CHILD !== '1') return;",
      "  const parameters = { type: 'object', properties: {} };",
      "  const execute = async () => ({ content: [{ type: 'text', text: 'fixture' }] });",
      "  pi.registerTool({ name: 'ask_user_question', label: 'Ask user fixture', description: 'fixture', parameters, execute });",
      "  pi.registerTool({ name: 'subagent', label: 'Subagent fixture', description: 'fixture', parameters, execute });",
      "  pi.on('session_start', () => { pi.setActiveTools([...pi.getActiveTools(), 'ask_user_question', 'subagent', 'intercom']); });",
      '}',
      '',
    ].join('\n'),
  );
}

interface DoomPiRpcOptions {
  hooks?: boolean;
  scenario?: string;
}

function startDoomPiRpc(
  root: string,
  agentDir: string,
  markerPath: string,
  options: DoomPiRpcOptions = {},
): ChildProcessWithoutNullStreams {
  const child = spawn(
    process.execPath,
    [
      doomPiCli,
      '--cwd',
      root,
      '--major-mode',
      'system',
      '--domains',
      'system',
      '--profile',
      'system',
      ...(options.hooks === true ? [] : ['--no-hooks']),
      '--no-mcp',
      '--mode',
      'rpc',
      '--no-session',
      '--approve',
      '--provider',
      'scripted',
      '--model',
      'scripted/system-test',
      '--extension',
      providerPath,
    ],
    {
      cwd: root,
      env: {
        ...cleanHarnessEnvironment({
          DOOM_TEAM_SYSTEM_INHERITANCE_TEST: '1',
          DOOM_TEAM_SYSTEM_LAYER_MARKER: markerPath,
          ...(options.scenario ? { DOOM_TEAM_SYSTEM_SCENARIO: options.scenario } : {}),
        }),
        PI_CODING_AGENT_DIR: agentDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  return child;
}

function waitForRecord(
  child: ChildProcessWithoutNullStreams,
  predicate: (record: RpcRecord) => boolean,
  timeoutMs = 15_000,
): Promise<RpcRecord> {
  return new Promise((resolve, reject) => {
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, record?: RpcRecord): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(record!);
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for Pi RPC record. stderr: ${stderr}`)),
      timeoutMs,
    );
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`Pi RPC exited before the expected record (code ${code}, signal ${signal}). stderr: ${stderr}`));
    };
    const onStdout = (chunk: Buffer): void => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      while (true) {
        const lf = stdoutBuffer.indexOf(0x0a);
        if (lf === -1) return;
        const line = stdoutBuffer.subarray(0, lf).toString('utf8').replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.subarray(lf + 1);
        if (!line) continue;
        let record: RpcRecord;
        try {
          record = JSON.parse(line) as RpcRecord;
        } catch {
          finish(new Error(`Pi emitted non-JSON stdout: ${line}`));
          return;
        }
        if (predicate(record)) {
          finish(undefined, record);
          return;
        }
      }
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

async function waitForCompletedRun(existingRuns: Set<string>, timeoutMs = 20_000): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const entry of runEntries()) {
      if (existingRuns.has(entry.runId)) continue;
      const status = readRunStatus(path.join(entry.runDir, 'status.json'));
      if (!status || status.agent !== 'system-worker') continue;
      if ((status.state === 'completed' || status.state === 'failed') && transcriptFor(status)) {
        return status;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for the detached Doom Team child to complete.');
}

async function waitForCompletedRuns(
  existingRuns: Set<string>,
  expectedCount: number,
  timeoutMs = 20_000,
): Promise<RunStatus[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const completed: RunStatus[] = [];
    for (const entry of runEntries()) {
      if (existingRuns.has(entry.runId)) continue;
      const status = readRunStatus(path.join(entry.runDir, 'status.json'));
      if (
        status?.agent === 'system-worker' &&
        (status.state === 'completed' || status.state === 'failed') &&
        transcriptFor(status)
      ) {
        completed.push(status);
      }
    }
    if (completed.length >= expectedCount) return completed;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expectedCount} detached Doom Team children to complete.`);
}

beforeAll(() => {
  fs.writeFileSync(
    providerPath,
    [
      `const { registerScriptedProvider } = require(${JSON.stringify(providerImplementationPath)});`,
      'export = registerScriptedProvider;',
      '',
    ].join('\n'),
  );
});

afterEach(async () => {
  const liveRpcProcesses = children.splice(0).filter((child) => child.exitCode === null && child.signalCode === null);
  await Promise.all(liveRpcProcesses.map((child) => stopRpcProcess(child)));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(providerPath, { force: true });
});

describe('Doom Team in a real Pi process', () => {
  it('loads the extension, executes the subagent tool, and completes a detached child', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-system-'));
    tempDirs.push(isolatedDir);
    const agentDir = path.join(isolatedDir, 'agent');
    writeAgent(agentDir);
    const existingRuns = currentRunIds();
    const child = startRpc(agentDir, {}, isolatedDir);
    const accepted = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'spawn' && record.success === true,
    );
    const ended = waitForRecord(child, (record) => record.type === 'agent_end');

    child.stdin.write(
      `${JSON.stringify({ id: 'spawn', type: 'prompt', message: 'Run the Doom Team system test.' })}\n`,
    );

    const [, endRecord] = await Promise.all([accepted, ended]);
    const outcome = spawnedOutcome(endRecord);
    expect(outcome).toBeDefined();
    const status = await waitForCompletedRun(existingRuns);

    expect(status.state).toBe('completed');
    expect(status.summary).toContain('CHILD_E2E_OK');
    expect(status.sessionFile).toBeTruthy();
    expect(fs.existsSync(status.sessionFile!)).toBe(true);
    expect(transcriptFor(status)).toBeTruthy();
    const transcript = fs.readFileSync(transcriptFor(status)!, 'utf8');
    expect(transcript).toContain('initial_prompt');
    expect(transcript).toContain('CHILD_E2E_OK');
    await waitForProcessExit(outcome!.pid);
    fs.rmSync(transcriptFor(status)!, { force: true });
  });

  it('projects explicit skill metadata, disables ambient skills, and lets the child read the body lazily', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-explicit-skill-system-'));
    tempDirs.push(isolatedDir);
    const agentDir = path.join(isolatedDir, 'agent');
    const configuredSkillPath = writeExplicitSkillAgent(agentDir, isolatedDir);
    const existingRuns = currentRunIds();
    const child = startRpc(agentDir, { DOOM_TEAM_SYSTEM_SCENARIO: 'explicit-skill' }, isolatedDir);
    const accepted = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'explicit-skill' && record.success === true,
      30_000,
    );
    const ended = waitForRecord(child, (record) => record.type === 'agent_end', 30_000);

    child.stdin.write(
      `${JSON.stringify({ id: 'explicit-skill', type: 'prompt', message: 'Verify explicit lazy skill projection.' })}\n`,
    );

    await Promise.all([accepted, ended]);
    const status = await waitForCompletedRun(existingRuns, 30_000);
    const summary = status.summary ?? '';

    expect(status.state).toBe('completed');
    expect(path.isAbsolute(configuredSkillPath)).toBe(true);
    expect(summary).toContain('CHILD_EXPLICIT_SKILL_E2E_OK');
    expect(summary).toContain('"ambientListed":false');
    expect(summary).toContain('"ambientSkillsDisabled":true');
    expect(summary).toContain('"bodyInjected":false');
    expect(summary).toContain('"descriptionPresent":true');
    expect(summary).toContain('"namePresent":true');
    expect(summary).toContain('"readActive":true');
    expect(summary).toContain('"readBodyPresent":true');
    expect(summary).toContain(configuredSkillPath);
    expect(transcriptFor(status)).toBeTruthy();
    const transcript = fs.readFileSync(transcriptFor(status)!, 'utf8');
    expect(transcript).toContain(explicitSkillBody);
    expect(transcript).toContain('CHILD_EXPLICIT_SKILL_E2E_OK');
  });

  it('reloads the real Pi runtime without duplicating Doom Team commands and still spawns afterward', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-reload-system-'));
    tempDirs.push(isolatedDir);
    const agentDir = path.join(isolatedDir, 'agent');
    writeAgent(agentDir);
    const child = startRpc(agentDir, {}, isolatedDir);
    const doomTeamCommands = [
      'run',
      'parallel',
      'subagents-doctor',
      'subagents-stop',
      'subagents-fleet',
      'subagents-list',
    ];

    const beforeResponse = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'commands-before' && record.success === true,
    );
    child.stdin.write(`${JSON.stringify({ id: 'commands-before', type: 'get_commands' })}\n`);
    const before = await beforeResponse;
    const beforeNames = ((before.data as { commands?: Array<{ name?: string }> } | undefined)?.commands ?? []).map(
      (command) => command.name,
    );

    const reloadResponse = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'reload' && record.success === true,
      30_000,
    );
    child.stdin.write(`${JSON.stringify({ id: 'reload', type: 'prompt', message: '/system-reload' })}\n`);
    await reloadResponse;

    const afterResponse = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'commands-after' && record.success === true,
    );
    child.stdin.write(`${JSON.stringify({ id: 'commands-after', type: 'get_commands' })}\n`);
    const after = await afterResponse;
    const afterNames = ((after.data as { commands?: Array<{ name?: string }> } | undefined)?.commands ?? []).map(
      (command) => command.name,
    );

    for (const commandName of doomTeamCommands) {
      expect(beforeNames.filter((name) => name === commandName)).toHaveLength(1);
      expect(afterNames.filter((name) => name === commandName)).toHaveLength(1);
    }

    const existingRuns = currentRunIds();
    const accepted = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'spawn-after-reload' && record.success === true,
    );
    const ended = waitForRecord(child, (record) => record.type === 'agent_end');
    child.stdin.write(
      `${JSON.stringify({ id: 'spawn-after-reload', type: 'prompt', message: 'Run after the real reload.' })}\n`,
    );

    await Promise.all([accepted, ended]);
    const status = await waitForCompletedRun(existingRuns);
    expect(status.state).toBe('completed');
    expect(status.summary).toContain('CHILD_E2E_OK');
  });

  it('reconciles a hard-killed detached SDK child to failed', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-sigkill-system-'));
    tempDirs.push(isolatedDir);
    const agentDir = path.join(isolatedDir, 'agent');
    writeAgent(agentDir);
    const child = startRpc(agentDir, { DOOM_TEAM_SYSTEM_SCENARIO: 'sigkill' }, isolatedDir);
    const accepted = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'sigkill' && record.success === true,
      30_000,
    );
    const ended = waitForRecord(child, (record) => record.type === 'agent_end', 30_000);

    child.stdin.write(`${JSON.stringify({ id: 'sigkill', type: 'prompt', message: 'Verify hard-kill recovery.' })}\n`);

    const [, endRecord] = await Promise.all([accepted, ended]);
    const outcome = spawnedOutcome(endRecord);
    expect(outcome).toBeDefined();
    expect(processExists(outcome!.pid)).toBe(true);
    process.kill(outcome!.pid, 'SIGKILL');

    const status = await waitForRunState(outcome!.runId, 'failed');
    expect(status.error).toContain('runner process');
    await waitForProcessExit(outcome!.pid);
  });

  it('stops a detached SDK child deterministically through the control channel', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-stop-system-'));
    tempDirs.push(isolatedDir);
    const agentDir = path.join(isolatedDir, 'agent');
    writeAgent(agentDir);
    const child = startRpc(agentDir, { DOOM_TEAM_SYSTEM_SCENARIO: 'sigkill' }, isolatedDir);
    const accepted = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'controlled-stop' && record.success === true,
      30_000,
    );
    const ended = waitForRecord(child, (record) => record.type === 'agent_end', 30_000);

    child.stdin.write(
      `${JSON.stringify({ id: 'controlled-stop', type: 'prompt', message: 'Verify controlled stop.' })}\n`,
    );

    const [, endRecord] = await Promise.all([accepted, ended]);
    const outcome = spawnedOutcome(endRecord);
    expect(outcome).toBeDefined();
    await waitForRunState(outcome!.runId, 'running');
    const runDir = runEntries().find((entry) => entry.runId === outcome!.runId)?.runDir;
    expect(runDir).toBeTruthy();

    requestAsyncStop(runDir!, { source: 'real-pi-system-test' });

    const status = await waitForRunState(outcome!.runId, 'stopped');
    expect(status.summary).toBe('Stopped before completion.');
    await waitForProcessExit(outcome!.pid);
  });

  it('inherits DoomPi selection and Team package policy in the detached SDK child', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-team-system-'));
    tempDirs.push(isolatedDir);
    const agentDir = path.join(isolatedDir, 'pi-agent');
    const markerPath = path.join(isolatedDir, 'layer-extension-loaded.txt');
    writeDoomPiRepository(isolatedDir);
    const existingRuns = currentRunIds();
    const child = startDoomPiRpc(isolatedDir, agentDir, markerPath);
    const accepted = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'spawn' && record.success === true,
      30_000,
    );
    const ended = waitForRecord(child, (record) => record.type === 'agent_end', 30_000);

    child.stdin.write(
      `${JSON.stringify({ id: 'spawn', type: 'prompt', message: 'Run the DoomPi inheritance system test.' })}\n`,
    );

    const [, endRecord] = await Promise.all([accepted, ended]);
    const outcome = spawnedOutcome(endRecord);
    expect(outcome, JSON.stringify(endRecord)).toBeDefined();
    const status = await waitForCompletedRun(existingRuns, 30_000);
    const transcriptPath = transcriptFor(status);
    expect(transcriptPath).toBeTruthy();
    const transcript = fs.readFileSync(transcriptPath!, 'utf8');
    const assistantEvidence = transcript
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RpcRecord)
      .find((record) => typeof record.text === 'string' && record.text.includes('"majorMode":"system"'));
    const evidence = JSON.parse(typeof assistantEvidence?.text === 'string' ? assistantEvidence.text : '{}') as Record<
      string,
      unknown
    >;

    expect(status.state).toBe('completed');
    expect(evidence.majorMode).toBe('system');
    expect(evidence.layers).toBe('plan-mode');
    expect(evidence.domains).toBe('system');
    expect(evidence.profile).toBe('system');
    expect(evidence.profileEnvironment).toBe('PROFILE_ENV_E2E_OK');
    expect(evidence.personaInherited).toBe(true);
    expect(evidence.skillInherited).toBe(true);
    expect(evidence.domainSkills).toEqual(expect.stringContaining('skills'));
    expect(evidence.tools).not.toEqual(expect.arrayContaining(['ask_user_question', 'intercom', 'subagent']));
    expect(transcript).toContain('PROFILE_ENV_E2E_OK');
  });

  it(
    'inherits consumer guardrail and vibe-lint extensions and blocks Yarn in the headless child',
    async () => {
      const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-team-guardrail-system-'));
      tempDirs.push(isolatedDir);
      const agentDir = path.join(isolatedDir, 'pi-agent');
      const markerPath = path.join(isolatedDir, 'layer-extension-loaded.txt');
      const guardrailExtensionPath = path.join(isolatedDir, consumerGuardrailFile);
      writeDoomPiRepository(isolatedDir);
      const existingRuns = currentRunIds();
      const child = startDoomPiRpc(isolatedDir, agentDir, markerPath, {
        hooks: true,
        scenario: 'guardrails',
      });
      const accepted = waitForRecord(
        child,
        (record) => record.type === 'response' && record.id === 'guardrails' && record.success === true,
        30_000,
      );
      const ended = waitForRecord(child, (record) => record.type === 'agent_end', 30_000);

      child.stdin.write(
        `${JSON.stringify({ id: 'guardrails', type: 'prompt', message: 'Verify detached child guardrails.' })}\n`,
      );

      const [, endRecord] = await Promise.all([accepted, ended]);
      const outcome = spawnedOutcome(endRecord);
      expect(outcome, JSON.stringify(endRecord)).toBeDefined();
      const status = await waitForCompletedRun(existingRuns, 30_000);
      const summary = status.summary ?? '';

      expect(status.state).toBe('completed');
      expect(summary).toContain('CHILD_GUARDRAIL_BLOCKED_E2E_OK');
      expect(transcriptFor(status)).toBeTruthy();
      const transcript = fs.readFileSync(transcriptFor(status)!, 'utf8');
      const assistantEvidence = transcript
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RpcRecord)
        .find(
          (record) => typeof record.text === 'string' && record.text.includes('CHILD_GUARDRAIL_BLOCKED_E2E_OK'),
        )?.text;
      expect(assistantEvidence).toContain('"guardrailsInherited":true');
      expect(assistantEvidence).toContain('"vibeLintInherited":true');
      expect(assistantEvidence).toContain('"yarnBlocked":true');
      expect(assistantEvidence).toContain(guardrailExtensionPath);
      expect(assistantEvidence).toContain(vibeLintExtensionPath);
      expect(transcript).toContain('yarn --version');
      expect(transcript).toContain('Use an Nx target instead of Yarn');
      expect(transcript).toContain('CHILD_GUARDRAIL_BLOCKED_E2E_OK');
      await waitForProcessExit(outcome!.pid);
    },
    guardrailTestTimeoutMs,
  );

  it('surfaces the child Pi steering acknowledgment verbatim', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-steer-system-'));
    tempDirs.push(isolatedDir);
    const agentDir = path.join(isolatedDir, 'agent');
    writeAgent(agentDir);
    const child = startRpc(agentDir, { DOOM_TEAM_SYSTEM_SCENARIO: 'steer' }, isolatedDir);
    const accepted = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'steer' && record.success === true,
      30_000,
    );
    const ended = waitForRecord(child, (record) => record.type === 'agent_end', 30_000);

    child.stdin.write(
      `${JSON.stringify({ id: 'steer', type: 'prompt', message: 'Verify acknowledged child steering.' })}\n`,
    );

    const [, endRecord] = await Promise.all([accepted, ended]);
    const evidence = JSON.stringify(endRecord);
    expect(evidence).toContain('STEER_E2E_OK');
    expect(evidence).toContain('Pi accepted the correlated steering input.');
    expect(evidence).toContain('"state":"delivered"');
  });

  it('supports intercom send, ask, and reply between two SDK children', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-team-system-'));
    tempDirs.push(isolatedDir);
    const agentDir = path.join(isolatedDir, 'agent');
    writeAgent(agentDir);
    const existingRuns = currentRunIds();
    const child = startRpc(agentDir, { DOOM_TEAM_SYSTEM_SCENARIO: 'team' }, isolatedDir);
    const accepted = waitForRecord(
      child,
      (record) => record.type === 'response' && record.id === 'team' && record.success === true,
      30_000,
    );
    const ended = waitForRecord(child, (record) => record.type === 'agent_end', 30_000);

    child.stdin.write(
      `${JSON.stringify({ id: 'team', type: 'prompt', message: 'Verify two-child team collaboration.' })}\n`,
    );

    const [, endRecord] = await Promise.all([accepted, ended]);
    const statuses = await waitForCompletedRuns(existingRuns, 2, 30_000);
    const transcripts = statuses.map((status) => fs.readFileSync(transcriptFor(status)!, 'utf8')).join('\n');
    const evidence = `${JSON.stringify(endRecord)}\n${transcripts}`;

    expect(statuses.map((status) => status.state)).toEqual(['completed', 'completed']);
    expect(evidence).toContain('TEAM_PARENT_E2E_OK');
    expect(evidence).toContain('TEAM_INITIATOR_E2E_OK');
    expect(evidence).toContain('TEAM_RESPONDER_E2E_OK');
    expect(evidence).toContain('TEAM_SEND_E2E_OK');
    expect(evidence).toContain('TEAM_ASK_E2E_OK');
    expect(evidence).toContain('TEAM_REPLY_E2E_OK');
    expect(evidence).toContain('delivery is not yet confirmed. Do not resend.');
    expect(evidence).toMatch(/system-worker-[a-f0-9]{8}/);
  });
});
