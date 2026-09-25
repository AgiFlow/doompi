import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunnerDependencies } from '../../src/services/runnerDependencies';
import { RunnerPaths } from '../../src/services/runnerPaths';

const directories: string[] = [];
function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-identity-'));
  directories.push(result);
  return result;
}
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runner session identity', () => {
  it('uses each admitted cwd and environment without inheriting ambient state', () => {
    const root = directory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    execFileSync('git', ['init', '-q', first]);
    execFileSync('git', ['init', '-q', second]);
    const agentA = path.join(root, 'agent-a');
    const agentB = path.join(root, 'agent-b');
    const a = createRunnerDependencies({
      cwd: first,
      environment: { PI_CODING_AGENT_DIR: agentA, PI_SESSION_ID: 'a' },
    });
    const b = createRunnerDependencies({
      cwd: second,
      environment: { PI_CODING_AGENT_DIR: agentB, PI_SESSION_ID: 'b' },
    });

    expect(a.paths.repositoryPath()).toBe(fs.realpathSync(first));
    expect(b.paths.repositoryPath()).toBe(fs.realpathSync(second));
    expect(a.paths.stateDirectory()).toBe(path.join(agentA, 'doom-runner', 'a', 'runs'));
    expect(b.paths.stateDirectory()).toBe(path.join(agentB, 'doom-runner', 'b', 'runs'));
    expect(a.paths.legacyDirectory()).toBe(path.join(fs.realpathSync(first), '.git', 'doom-runner'));
    expect(b.paths.legacyDirectory()).toBe(path.join(fs.realpathSync(second), '.git', 'doom-runner'));
  });

  it('anchors relative log and agent overrides to their own session cwd', () => {
    const root = directory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const agentA = new RunnerPaths(first, { PI_CODING_AGENT_DIR: 'agent', PI_SESSION_ID: 'a' });
    const agentB = new RunnerPaths(second, { PI_CODING_AGENT_DIR: 'agent', PI_SESSION_ID: 'b' });
    expect(agentA.stateDirectory()).toBe(path.join(first, 'agent', 'doom-runner', 'a', 'runs'));
    expect(agentB.stateDirectory()).toBe(path.join(second, 'agent', 'doom-runner', 'b', 'runs'));

    const logsA = new RunnerPaths(first, { DOOM_RUNNER_LOG_DIR: 'logs', PI_SESSION_ID: 'a' });
    const logsB = new RunnerPaths(second, { DOOM_RUNNER_LOG_DIR: 'logs', PI_SESSION_ID: 'b' });
    expect(logsA.logDirectory()).toBe(path.join(first, 'logs'));
    expect(logsB.logDirectory()).toBe(path.join(second, 'logs'));
    expect(logsA.stateDirectory()).toBe(path.join(first, 'runs'));
    expect(logsB.stateDirectory()).toBe(path.join(second, 'runs'));
  });

  it('removes only the legacy store belonging to the supplied worktree', () => {
    const root = directory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    execFileSync('git', ['init', '-q', first]);
    execFileSync('git', ['init', '-q', second]);
    const firstStore = path.join(fs.realpathSync(first), '.git', 'doom-runner');
    const secondStore = path.join(fs.realpathSync(second), '.git', 'doom-runner');
    fs.mkdirSync(firstStore);
    fs.mkdirSync(secondStore);
    fs.writeFileSync(path.join(firstStore, 'old'), 'old');
    fs.writeFileSync(path.join(secondStore, 'keep'), 'keep');

    expect(new RunnerPaths(first, {}).removeLegacyStore()).toBe(firstStore);
    expect(fs.existsSync(firstStore)).toBe(false);
    expect(fs.existsSync(path.join(secondStore, 'keep'))).toBe(true);
  });
});
