import { describe, expect, it } from 'vitest';
import { buildSandboxPlan, type SandboxPlanInput } from '../../../src/services/sandboxPlan.ts';
import { sandboxImageTag } from '../../../src/adapters/sandboxImageTag.ts';

function input(overrides: Partial<SandboxPlanInput> = {}): SandboxPlanInput {
  return {
    repoRoot: '/work/repo',
    cwd: '/work/repo/apps/site',
    forwardArgs: ['--major-mode', 'copilot', 'run'],
    environment: { TERM: 'xterm-256color', SECRET_THING: 'no', ANTHROPIC_API_KEY: 'key' },
    engine: 'docker',
    host: { hasTty: true, platform: 'darwin', repoKey: 'doompi-sandbox-abc123def456', version: '1.2.3' },
    imageTag: sandboxImageTag('1.2.3'),
    ...overrides,
  };
}

describe('buildSandboxPlan', () => {
  it('runs a disposable container with the workspace mounted at its host path', () => {
    const plan = buildSandboxPlan(input());

    expect(plan.imageTag).toBe(sandboxImageTag('1.2.3'));
    expect(plan.runArgs.slice(0, 4)).toEqual(['run', '--rm', '-i', '-t']);
    expect(plan.runArgs).toContain('/work/repo:/work/repo');
    expect(plan.runArgs.join(' ')).toContain('-w /work/repo/apps/site');
    expect(plan.runArgs.slice(-5)).toEqual([sandboxImageTag('1.2.3'), 'doompi', '--major-mode', 'copilot', 'run']);
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

  it('places configured engine options immediately before the image', () => {
    const plan = buildSandboxPlan(input({ runFlags: ['--runtime=runsc', '--read-only'] }));
    const imageIndex = plan.runArgs.indexOf(sandboxImageTag('1.2.3'));

    expect(plan.runArgs[imageIndex - 2]).toBe('--runtime=runsc');
    expect(plan.runArgs[imageIndex - 1]).toBe('--read-only');
  });

  it('emits no extra options when none are configured', () => {
    expect(buildSandboxPlan(input()).runArgs).not.toContain('--runtime=runsc');
  });

  describe('with a host broker', () => {
    const broker = {
      socketDirectory: '/tmp/doompi-broker-xyz',
      token: 'session-token',
      providers: ['anthropic', 'groq'],
      withheldEnv: ['ANTHROPIC_API_KEY', 'GROQ_API_KEY'],
    };

    it('mounts the broker socket and wraps the launcher in the bridge', () => {
      const plan = buildSandboxPlan(input({ broker }));

      expect(plan.runArgs).toContain('/tmp/doompi-broker-xyz:/run/doompi');
      expect(plan.runArgs.slice(-6)).toEqual([
        'node',
        '/opt/doompi/sandbox-bridge.mjs',
        'doompi',
        '--major-mode',
        'copilot',
        'run',
      ]);
      expect(plan.runArgs).toContain('DOOMPI_BROKER_SOCKET=/run/doompi/broker.sock');
      expect(plan.runArgs).toContain('DOOMPI_BROKER_PORT=8317');
      expect(plan.runArgs).toContain('DOOMPI_BROKER_PROVIDERS=anthropic,groq');
    });

    it('replaces every provider key with the session token', () => {
      const plan = buildSandboxPlan({
        ...input({ broker }),
        environment: { ANTHROPIC_API_KEY: 'real-anthropic', GROQ_API_KEY: 'real-groq', TERM: 'xterm-256color' },
      });

      expect(plan.runArgs).toContain('ANTHROPIC_API_KEY=session-token');
      expect(plan.runArgs).toContain('GROQ_API_KEY=session-token');
      expect(plan.runArgs.join(' ')).not.toContain('real-anthropic');
      expect(plan.runArgs.join(' ')).not.toContain('real-groq');
      expect(plan.runArgs).toContain('TERM=xterm-256color');
    });

    it('withholds credentials for providers the broker cannot carry', () => {
      const plan = buildSandboxPlan({
        ...input({ broker }),
        environment: {
          ANTHROPIC_API_KEY: 'real-anthropic',
          COPILOT_GITHUB_TOKEN: 'gh',
          ANTHROPIC_BASE_URL: 'https://gw',
        },
      });

      expect(plan.runArgs.join(' ')).not.toContain('gh');
      expect(plan.runArgs.join(' ')).not.toContain('COPILOT_GITHUB_TOKEN');
      expect(plan.runArgs.join(' ')).not.toContain('ANTHROPIC_BASE_URL');
    });
  });

  it('never maps a user on darwin where the engine owns the mapping', () => {
    const plan = buildSandboxPlan(input({ host: { ...input().host, userId: 501, groupId: 20 } }));

    expect(plan.runArgs).not.toContain('--user');
  });
});
