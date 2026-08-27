import { describe, expect, it } from 'vitest';
import {
  COCKPIT_HOME_VOLUME,
  COCKPIT_LABEL,
  buildCockpitPlan,
  type CockpitPlanInput,
} from '../../../src/services/cockpitPlan.ts';
import type { SandboxHostFacts } from '../../../src/types/sandboxHarness.ts';

const HOST: SandboxHostFacts = {
  hasTty: true,
  platform: 'darwin',
  repoKey: 'doompi-sandbox-abc123',
  version: '1.2.3',
};

function plan(overrides: Partial<CockpitPlanInput> = {}): string[] {
  return buildCockpitPlan({
    workspaces: [{ path: '/Users/someone/work/repo' }],
    port: 7433,
    environment: { TERM: 'xterm', SECRET_THING: 'no' },
    engine: 'docker',
    host: HOST,
    imageTag: 'doompi-sandbox:v1.2.3-deadbeef',
    ...overrides,
  }).runArgs;
}

/** The value following a flag, so a test names what it means rather than an index. */
function valueAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ''] : []));
}

describe('the detached run', () => {
  it('runs detached and keeps the container after it exits', () => {
    // Not --rm: a container that dies on startup has to survive long enough for
    // its logs to be read. Stop and reap remove it.
    const args = plan();
    expect(args[0]).toBe('run');
    expect(args).toContain('-d');
    expect(args).not.toContain('--rm');
    expect(args).not.toContain('-i');
    expect(args).not.toContain('-t');
  });

  it('labels the container with its port so an orphan can be found', () => {
    expect(valueAfter(plan(), '--label')).toBe(`${COCKPIT_LABEL}=7433`);
  });
});

describe('the published port', () => {
  it('publishes onto host loopback only', () => {
    expect(valueAfter(plan({ port: 9001 }), '-p')).toBe('127.0.0.1:9001:9001');
  });

  it('binds every interface inside, because a publish never reaches container loopback', () => {
    const args = plan({ port: 9001 });
    expect(args.slice(-4)).toEqual(['--host', '0.0.0.0', '--port', '9001']);
    expect(args.at(-5)).toBe('doompi-web');
  });
});

describe('mounts', () => {
  it('mounts each workspace at its identical host path', () => {
    const args = plan({ workspaces: [{ path: '/a/one' }, { path: '/b/two' }] });
    expect(valuesAfter(args, '-v')).toContain('/a/one:/a/one');
    expect(valuesAfter(args, '-v')).toContain('/b/two:/b/two');
  });

  it('works in the first workspace', () => {
    expect(valueAfter(plan({ workspaces: [{ path: '/a/one' }, { path: '/b/two' }] }), '-w')).toBe('/a/one');
  });

  it('uses one cockpit-scoped home volume, not a per-repository one', () => {
    // Paired passkeys and the bundle signing key live here. A rotated signing
    // key would make every paired device refuse the cockpit.
    const mounts = valuesAfter(plan(), '-v');
    expect(mounts).toContain(`${COCKPIT_HOME_VOLUME}:/doompi-home`);
    expect(mounts.some((mount) => mount.includes(HOST.repoKey))).toBe(false);
  });

  it('mounts nothing else: no host home, no ssh, no docker socket', () => {
    const mounts = valuesAfter(plan(), '-v');
    expect(mounts).toEqual([
      '/Users/someone/work/repo:/Users/someone/work/repo',
      `${COCKPIT_HOME_VOLUME}:/doompi-home`,
    ]);
  });

  it('refuses to build a plan with nothing mounted', () => {
    // A cockpit with no workspace can create no session, and the empty mount
    // set would read as "everything" to someone skimming the argv.
    expect(() => buildCockpitPlan({ ...({} as CockpitPlanInput), workspaces: [] })).toThrow(/at least one workspace/u);
  });
});

describe('environment', () => {
  it('disables the devcontainer path, which would hand the mounts to the workspace author', () => {
    expect(valuesAfter(plan(), '-e')).toContain('DOOMPI_SANDBOX_DEVCONTAINER=0');
  });

  it('marks the container so nothing inside can claim to be unsandboxed', () => {
    expect(valuesAfter(plan(), '-e')).toContain('DOOMPI_SANDBOX=1');
  });

  it('keeps the allowlist, so an unrelated host variable does not travel', () => {
    const env = valuesAfter(plan(), '-e');
    expect(env).toContain('TERM=xterm');
    expect(env.some((pair) => pair.startsWith('SECRET_THING='))).toBe(false);
  });

  it('passes a git identity so the agent can commit', () => {
    const env = valuesAfter(plan({ gitIdentity: { name: 'A Dev', email: 'dev@example.com' } }), '-e');
    expect(env).toContain('GIT_AUTHOR_NAME=A Dev');
    expect(env).toContain('GIT_COMMITTER_EMAIL=dev@example.com');
  });

  it('passes no key, so the agent cannot push', () => {
    const env = valuesAfter(plan({ gitIdentity: { name: 'A Dev', email: 'dev@example.com' } }), '-e');
    expect(env.some((pair) => pair.startsWith('SSH_AUTH_SOCK='))).toBe(false);
  });

  it('sorts the pairs by name, so the argv is deterministic', () => {
    const names = valuesAfter(plan(), '-e')
      .filter((pair) => pair !== 'HOME=/doompi-home')
      .map((pair) => pair.split('=')[0] ?? '');
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
  });
});

describe('operator run flags', () => {
  it('places them last, so a configured option wins and cannot be read as the image', () => {
    const args = plan({ runFlags: ['--runtime=runsc'] });
    expect(args[args.indexOf('--runtime=runsc') + 1]).toBe('doompi-sandbox:v1.2.3-deadbeef');
  });
});

describe('the broker route', () => {
  const broker = { token: 't', providers: ['anthropic'], withheldEnv: ['ANTHROPIC_API_KEY'] };

  it('names the host gateway when the broker is on a loopback port', () => {
    const args = plan({ broker: { ...broker, endpoint: { transport: 'tcp', port: 5000 } } });
    expect(valueAfter(args, '--add-host')).toBe('host.docker.internal:host-gateway');
  });

  it('mounts the socket directory instead when the broker is on a socket', () => {
    const args = plan({ broker: { ...broker, endpoint: { transport: 'unix', socketDirectory: '/tmp/b' } } });
    expect(valuesAfter(args, '-v')).toContain('/tmp/b:/run/doompi');
    expect(args).not.toContain('--add-host');
  });
});

describe('user mapping', () => {
  it('maps the host user on linux', () => {
    const args = plan({ host: { ...HOST, platform: 'linux', userId: 501, groupId: 20 } });
    expect(valueAfter(args, '--user')).toBe('501:20');
  });

  it('adds keep-id for podman', () => {
    const args = plan({ engine: 'podman', host: { ...HOST, platform: 'linux', userId: 501, groupId: 20 } });
    expect(args).toContain('--userns=keep-id');
  });

  it('leaves the mapping to the engine on a virtual machine backed host', () => {
    expect(plan({ host: { ...HOST, platform: 'darwin', userId: 501 } })).not.toContain('--user');
  });
});
