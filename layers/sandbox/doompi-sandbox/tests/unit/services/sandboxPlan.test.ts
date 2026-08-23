import { describe, expect, it } from 'vitest';
import { buildSandboxPlan, type SandboxPlanInput } from '../../../src/services/sandboxPlan.ts';

function input(overrides: Partial<SandboxPlanInput> = {}): SandboxPlanInput {
  return {
    repoRoot: '/work/repo',
    cwd: '/work/repo/apps/site',
    forwardArgs: ['--major-mode', 'copilot', 'run'],
    environment: { TERM: 'xterm-256color', SECRET_THING: 'no', ANTHROPIC_API_KEY: 'key' },
    engine: 'docker',
    host: { hasTty: true, platform: 'darwin', repoKey: 'doompi-sandbox-abc123def456', version: '1.2.3' },
    ...overrides,
  };
}

describe('buildSandboxPlan', () => {
  it('runs a disposable container with the workspace mounted at its host path', () => {
    const plan = buildSandboxPlan(input());

    expect(plan.imageTag).toBe('doompi-sandbox:v1.2.3');
    expect(plan.runArgs.slice(0, 4)).toEqual(['run', '--rm', '-i', '-t']);
    expect(plan.runArgs).toContain('/work/repo:/work/repo');
    expect(plan.runArgs.join(' ')).toContain('-w /work/repo/apps/site');
    expect(plan.runArgs.slice(-5)).toEqual(['doompi-sandbox:v1.2.3', 'doompi', '--major-mode', 'copilot', 'run']);
  });

  it('shadows the repository package store and isolates the home directory', () => {
    const plan = buildSandboxPlan(input());

    expect(plan.runArgs).toContain('doompi-sandbox-abc123def456-home:/doompi-home');
    expect(plan.runArgs).toContain('doompi-sandbox-abc123def456-pi:/work/repo/.pi');
    expect(plan.runArgs).toContain('HOME=/doompi-home');
  });

  it('marks the session and forwards only allowlisted environment values', () => {
    const plan = buildSandboxPlan(input());

    expect(plan.runArgs).toContain('DOOMPI_SANDBOX=1');
    expect(plan.runArgs).toContain('TERM=xterm-256color');
    expect(plan.runArgs).toContain('ANTHROPIC_API_KEY=key');
    expect(plan.runArgs.join(' ')).not.toContain('SECRET_THING');
  });

  it('drops the terminal flag when the session has no tty', () => {
    const plan = buildSandboxPlan(input({ host: { ...input().host, hasTty: false } }));

    expect(plan.runArgs).not.toContain('-t');
    expect(plan.runArgs).toContain('-i');
  });

  it('maps the host user on linux and keeps the podman user namespace', () => {
    const linuxHost = { ...input().host, platform: 'linux', userId: 1000, groupId: 100 };

    const docker = buildSandboxPlan(input({ host: linuxHost }));
    expect(docker.runArgs).toContain('--user');
    expect(docker.runArgs).toContain('1000:100');
    expect(docker.runArgs).not.toContain('--userns=keep-id');

    const podman = buildSandboxPlan(input({ engine: 'podman', host: linuxHost }));
    expect(podman.runArgs).toContain('--userns=keep-id');
  });

  it('never maps a user on darwin where the engine owns the mapping', () => {
    const plan = buildSandboxPlan(input({ host: { ...input().host, userId: 501, groupId: 20 } }));

    expect(plan.runArgs).not.toContain('--user');
  });
});
