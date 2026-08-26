import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const doompiMocks = vi.hoisted(() => ({
  buildHarnessContext: vi.fn(),
  ensureLayerPackages: vi.fn(),
  resolveHarnessOptions: vi.fn(),
  resolveLaunchPlan: vi.fn(),
}));
const telemetryMocks = vi.hoisted(() => ({ createHarnessTelemetry: vi.fn(() => ({})) }));
const utilsMocks = vi.hoisted(() => ({ piCliPath: vi.fn(() => '/pi/cli.js') }));

vi.mock('@agimon-ai/doompi/cli', () => ({ resolveHarnessOptions: doompiMocks.resolveHarnessOptions }));
vi.mock('@agimon-ai/doompi/services', () => doompiMocks);
vi.mock('@agimon-ai/doompi/logSinkTelemetry', () => telemetryMocks);
vi.mock('@agimon-ai/doompi/utils', () => utilsMocks);

const { createDoomAgentLauncher, pinnedDoomPiCli } = await import('../../../src/adapters/doomAgentLauncher.ts');

const CWD = '/workspace/repo';
const BASE_ARGS = ['--name', 'web', '--mode', 'rpc'];
/** In-process composition is the default; the pin lookup is covered separately. */
const noPin = () => undefined;

/** Records every context the launcher builds so disposal can be asserted. */
const contexts: Array<{ cleanup: ReturnType<typeof vi.fn>; majorModesConfig: unknown; selectedLayers: string[] }> = [];

beforeEach(() => {
  contexts.splice(0);
  for (const mock of Object.values(doompiMocks)) mock.mockReset();

  doompiMocks.resolveHarnessOptions.mockImplementation(({ args }: { args: string[] }) => ({
    repoRoot: CWD,
    cwd: CWD,
    piArgs: args,
  }));
  doompiMocks.buildHarnessContext.mockImplementation(() => {
    const context = {
      cleanup: vi.fn(() => Promise.resolve()),
      majorModesConfig: { defaultMajorMode: 'copilot' },
      selectedLayers: ['team'],
      environment: { DOOMPI: '1' },
    };
    contexts.push(context);
    return Promise.resolve(context);
  });
  doompiMocks.ensureLayerPackages.mockResolvedValue(undefined);
  doompiMocks.resolveLaunchPlan.mockImplementation((context: { environment: NodeJS.ProcessEnv }) => {
    const options = doompiMocks.resolveHarnessOptions.mock.results.at(-1)?.value as { piArgs: string[] };
    return Promise.resolve({
      piArgs: ['--extension', '/bundle.mjs', ...options.piArgs],
      environment: context.environment,
    });
  });
});

describe('createDoomAgentLauncher', () => {
  it('runs Pi directly under this node with the composed extension bundle', async () => {
    const launcher = createDoomAgentLauncher({ agentArgs: BASE_ARGS, cwd: CWD, resolvePinnedCli: noPin });

    const launch = await launcher.resolve();

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(['/pi/cli.js', '--extension', '/bundle.mjs', ...BASE_ARGS]);
    expect(launch.cwd).toBe(CWD);
    expect(launch.env).toEqual({ DOOMPI: '1' });
  });

  it('stages the layer packages the selected composition needs', async () => {
    const launcher = createDoomAgentLauncher({ agentArgs: BASE_ARGS, cwd: CWD, resolvePinnedCli: noPin });

    await launcher.resolve();

    expect(doompiMocks.ensureLayerPackages).toHaveBeenCalledWith({
      repoRoot: CWD,
      config: { defaultMajorMode: 'copilot' },
      layers: ['team'],
      environment: { DOOMPI: '1' },
    });
  });

  it('pins the requested major mode without accumulating flags', async () => {
    const launcher = createDoomAgentLauncher({ agentArgs: BASE_ARGS, cwd: CWD, resolvePinnedCli: noPin });

    await launcher.resolve();
    const switched = await launcher.resolve('minimal');
    const again = await launcher.resolve('copilot');

    expect(switched.args).toEqual([
      '/pi/cli.js',
      '--extension',
      '/bundle.mjs',
      ...BASE_ARGS,
      '--major-mode',
      'minimal',
    ]);
    expect(again.args).toEqual(['/pi/cli.js', '--extension', '/bundle.mjs', ...BASE_ARGS, '--major-mode', 'copilot']);
  });

  it('releases the previous composition before staging the next one', async () => {
    const launcher = createDoomAgentLauncher({ agentArgs: BASE_ARGS, cwd: CWD, resolvePinnedCli: noPin });

    await launcher.resolve();
    await launcher.resolve('minimal');

    expect(contexts[0]?.cleanup).toHaveBeenCalledOnce();
    expect(contexts[1]?.cleanup).not.toHaveBeenCalled();

    await launcher.cleanup();
    expect(contexts[1]?.cleanup).toHaveBeenCalledOnce();
  });

  it('reports a failed cleanup instead of failing the session', async () => {
    const notices: string[] = [];
    const launcher = createDoomAgentLauncher({
      agentArgs: BASE_ARGS,
      cwd: CWD,
      onNotice: (m) => notices.push(m),
      resolvePinnedCli: noPin,
    });

    await launcher.resolve();
    contexts[0]?.cleanup.mockRejectedValueOnce(new Error('directory is busy'));

    await expect(launcher.cleanup()).resolves.toBeUndefined();
    expect(notices.some((notice) => notice.includes('directory is busy'))).toBe(true);
  });

  it('delegates to the DoomPi the repository pins rather than substituting its own', async () => {
    const notices: string[] = [];
    const launcher = createDoomAgentLauncher({
      agentArgs: BASE_ARGS,
      cwd: CWD,
      onNotice: (m) => notices.push(m),
      resolvePinnedCli: () => '/workspace/repo/node_modules/@agimon-ai/doompi/dist/bin/cli.mjs',
    });

    const launch = await launcher.resolve();
    const switched = await launcher.resolve('minimal');

    // Composition belongs to the pinned version, so nothing is composed here.
    expect(doompiMocks.buildHarnessContext).not.toHaveBeenCalled();
    expect(launch.args).toEqual(['/workspace/repo/node_modules/@agimon-ai/doompi/dist/bin/cli.mjs', ...BASE_ARGS]);
    expect(switched.args).toEqual([
      '/workspace/repo/node_modules/@agimon-ai/doompi/dist/bin/cli.mjs',
      ...BASE_ARGS,
      '--major-mode',
      'minimal',
    ]);
    expect(notices.some((notice) => notice.includes("this repository's"))).toBe(true);
  });

  it('lets DOOMPI_AGENT_COMMAND override the repository lookup', async () => {
    const launcher = createDoomAgentLauncher({
      agentArgs: BASE_ARGS,
      cwd: CWD,
      environment: { DOOMPI_AGENT_COMMAND: '/checkout/dist/bin/cli.mjs' },
      resolvePinnedCli: () => '/workspace/repo/node_modules/@agimon-ai/doompi/dist/bin/cli.mjs',
    });

    const launch = await launcher.resolve();

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(['/checkout/dist/bin/cli.mjs', ...BASE_ARGS]);
  });

  it('treats a configured launcher without a script suffix as the command itself', async () => {
    const launcher = createDoomAgentLauncher({
      agentArgs: BASE_ARGS,
      cwd: CWD,
      environment: { DOOMPI_AGENT_COMMAND: 'doompi' },
      resolvePinnedCli: noPin,
    });

    const launch = await launcher.resolve();

    expect(launch.command).toBe('doompi');
    expect(launch.args).toEqual(BASE_ARGS);
  });
});

describe('pinnedDoomPiCli', () => {
  const OWN = '/srv/node_modules/@agimon-ai/doompi';
  const REPO = '/workspace/repo/node_modules/@agimon-ai/doompi';

  it('finds the nearest repository pin above the session directory', () => {
    const cli = pinnedDoomPiCli('/workspace/repo/packages/app', OWN, (file) => file.startsWith(REPO));

    expect(cli).toBe(path.join(REPO, 'dist', 'bin', 'cli.mjs'));
  });

  it('composes in process when the repository resolves to this server own copy', () => {
    // The workspace case: the pin and the import are the same installation.
    expect(pinnedDoomPiCli('/srv', OWN, (file) => file.startsWith(OWN))).toBeUndefined();
  });

  it('composes in process when no repository above the session pins DoomPi', () => {
    expect(pinnedDoomPiCli('/workspace/repo', OWN, () => false)).toBeUndefined();
  });

  it('delegates when the pin exists but this server own copy cannot be resolved', () => {
    // Unknown is not the same as matching, so the repository version wins.
    expect(pinnedDoomPiCli('/workspace/repo', undefined, (file) => file.startsWith(REPO))).toBe(
      path.join(REPO, 'dist', 'bin', 'cli.mjs'),
    );
  });

  it('composes in process when a pinned package ships no built CLI', () => {
    const cli = pinnedDoomPiCli('/workspace/repo', OWN, (file) => file === path.join(REPO, 'package.json'));

    expect(cli).toBeUndefined();
  });
});
