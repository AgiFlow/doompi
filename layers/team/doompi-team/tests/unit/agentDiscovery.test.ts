import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetHarnessStore, updateHarnessState } from '@agimon-ai/doompi-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSubagentLaunchContract } from '../../src/exports';
import { AgentDiscoveryService, mergeAgentsForScope } from '../../src/adapters/agents/discovery';
import { EXTRA_AGENT_DIRS_ENV } from '../../src/adapters/agents/loader';
import type { AgentConfig } from '../../src/adapters/agents/types';
import { resetConfigDirNameCache } from '../../src/adapters/filesystem/configDir';

const CONFIG_DIR_NAME = '.pi';

/**
 * A service whose TTL and clock are under the test's control.
 *
 * The seams are protected members rather than constructor arguments because the
 * container resolves this service by type and inversify cannot supply a
 * primitive, so a subclass is the intended way to vary them.
 */
class TestableDiscoveryService extends AgentDiscoveryService {
  public currentTime = 1_000_000;
  /** How many times the uncached read actually ran. */
  public loadCount = 0;
  protected override readonly ttlMs: number = 5_000;

  protected override now(): number {
    return this.currentTime;
  }

  protected override load(cwd: string, scope: Parameters<AgentDiscoveryService['discover']>[1]) {
    this.loadCount++;
    return super.load(cwd, scope);
  }

  advance(ms: number): void {
    this.currentTime += ms;
  }
}

const temporaryDirs: string[] = [];
const originalEnv = { ...process.env };

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-discovery-'));
  temporaryDirs.push(dir);
  return dir;
}

/** A project root, recognised by its config directory. */
function makeProject(): { root: string; agentsDir: string } {
  const root = makeTempDir();
  const agentsDir = path.join(root, CONFIG_DIR_NAME, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  return { root, agentsDir };
}

/**
 * Write an agent file.
 *
 * Both `name` and `description` are required by the loader; a file missing
 * either is treated as documentation rather than as an agent.
 */
function writeAgent(dir: string, name: string, frontmatter: Record<string, string> = {}): void {
  const fields = Object.entries({ name, description: `the ${name} agent`, ...frontmatter })
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${fields}\n---\n\nYou are ${name}.\n`);
}

/** Disable an agent through project settings, the only mechanism that does so. */
function writeProjectSettings(root: string, settings: Record<string, unknown>): void {
  const dir = path.join(root, CONFIG_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
}

function writeLayers(root: string, content: string): void {
  const dir = path.join(root, '.doom');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'modes.yaml'), content);
}

beforeEach(() => {
  // Point every user-level lookup at a throwaway directory so no test can read
  // or write the real user config.
  const userDir = makeTempDir();
  process.env.PI_CODING_AGENT_DIR = userDir;
  delete process.env[EXTRA_AGENT_DIRS_ENV];
  resetConfigDirNameCache();
  // These cases set the harness environment directly. The store caches this
  // process's state, so it has to be dropped between them.
  resetHarnessStore();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetConfigDirNameCache();
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('mergeAgentsForScope', () => {
  function agent(name: string, source: AgentConfig['source']): AgentConfig {
    return {
      name,
      description: name,
      source,
      filePath: `/${source}/${name}.md`,
      systemPrompt: '',
      systemPromptMode: 'append',
      inheritProjectContext: true,
      inheritSkills: true,
    };
  }

  it('lets a project agent shadow a user agent of the same name', () => {
    const merged = mergeAgentsForScope('both', [agent('a', 'user')], [agent('a', 'project')], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe('project');
  });

  it('lets a user agent shadow a plugin agent', () => {
    const merged = mergeAgentsForScope('both', [agent('a', 'user')], [], [agent('a', 'plugin')]);
    expect(merged[0]?.source).toBe('user');
  });

  it('excludes project agents from user scope and vice versa', () => {
    const user = [agent('u', 'user')];
    const project = [agent('p', 'project')];

    expect(mergeAgentsForScope('user', user, project, []).map((entry) => entry.name)).toEqual(['u']);
    expect(mergeAgentsForScope('project', user, project, []).map((entry) => entry.name)).toEqual(['p']);
  });

  it('keeps plugin agents in every scope, since they are not user or project owned', () => {
    const plugin = [agent('builtin', 'plugin')];
    for (const scope of ['user', 'project', 'both'] as const) {
      expect(mergeAgentsForScope(scope, [], [], plugin).map((entry) => entry.name)).toContain('builtin');
    }
  });
});

describe('AgentDiscoveryService', () => {
  it('finds a project agent', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'reviewer');

    const service = new TestableDiscoveryService();
    const result = service.discover(root, 'both');

    expect(result.agents.map((agent) => agent.name)).toEqual(['reviewer']);
    expect(result.projectAgentsDir).toBe(agentsDir);
  });

  it('returns an empty result outside any project', () => {
    const service = new TestableDiscoveryService();
    const result = service.discover(makeTempDir(), 'both');

    expect(result.agents).toEqual([]);
    expect(result.projectAgentsDir).toBeNull();
  });

  it('resolves a single agent by name', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'reviewer');

    const service = new TestableDiscoveryService();
    expect(service.find(root, 'both', 'reviewer')?.name).toBe('reviewer');
    expect(service.find(root, 'both', 'absent')).toBeUndefined();
  });

  it('drops an agent disabled by settings', () => {
    // `disabled` is only ever set by a settings override, never by frontmatter,
    // so this is the mechanism the filter in discovery actually serves.
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'reviewer');
    writeAgent(agentsDir, 'retired');
    writeProjectSettings(root, { subagents: { agentOverrides: { retired: { disabled: true } } } });

    const service = new TestableDiscoveryService();
    expect(service.discover(root, 'both').agents.map((agent) => agent.name)).toEqual(['reviewer']);
  });

  it('applies selected Team package defaults while preserving agent-specific configuration', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'inherited');
    writeAgent(agentsDir, 'declared', { model: 'own/model', fallbackModels: 'own/fallback' });
    writeAgent(agentsDir, 'overridden');
    writeProjectSettings(root, {
      subagents: {
        defaultModel: 'legacy/model',
        agentOverrides: { overridden: { model: 'override/model', fallbackModels: ['override/fallback'] } },
      },
    });
    writeLayers(
      root,
      `layers:
  team:
    packages:
      - name: '@agimon-ai/doompi-team'
        config:
          models:
            - model: layer/model
              thinking: high
            - model: layer/fallback
              thinking: low
majorMode:
  copilot: [team]
`,
    );
    process.env.DOOMPI_ROOT = root;
    process.env.DOOMPI_LAYERS = 'team';

    const agents = new TestableDiscoveryService().discover(root, 'both').agents;

    expect(agents.find((agent) => agent.name === 'inherited')).toMatchObject({
      model: 'layer/model:high',
      modelSource: { type: 'packages.team.defaultModel', scope: 'package' },
    });
    expect(agents.find((agent) => agent.name === 'inherited')?.fallbackModels).toBeUndefined();
    expect(agents.find((agent) => agent.name === 'declared')).toMatchObject({
      model: 'own/model',
      fallbackModels: ['own/fallback'],
    });
    expect(agents.find((agent) => agent.name === 'overridden')).toMatchObject({
      model: 'override/model',
      fallbackModels: ['override/fallback'],
    });
    expect(agents.find((agent) => agent.name === 'overridden')?.modelSource).toBeUndefined();
  });

  it('applies Team package configuration from defaults without named layers', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'worker');
    writeLayers(
      root,
      `default:
  packages:
    - name: '@agimon-ai/doompi-team'
      config:
        models:
          - model: default/model
            thinking: high
majorMode:
  copilot: []
`,
    );
    process.env.DOOMPI_ROOT = root;
    process.env.DOOMPI_LAYERS = '';

    const agents = new TestableDiscoveryService().discover(root, 'both').agents;

    expect(agents[0]).toMatchObject({
      model: 'default/model:high',
      modelSource: { type: 'packages.team.defaultModel', scope: 'package' },
    });
  });
});

describe('resolveSubagentLaunchContract', () => {
  it('returns the resolved agent, cwd, and inherited default context', async () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'reviewer', { defaultContext: 'fork' });

    const result = await resolveSubagentLaunchContract({ agent: 'reviewer', cwd: root });

    expect(result).toMatchObject({
      ok: true,
      contract: { agent: { name: 'reviewer' }, cwd: root, context: 'fork' },
    });
  });

  it('rejects a cwd that is not a directory before agent discovery', async () => {
    const result = await resolveSubagentLaunchContract({ agent: 'reviewer', cwd: path.join(makeTempDir(), 'missing') });

    expect(result).toMatchObject({ ok: false, code: 'invalid_cwd' });
  });

  it('reports an agent that is unavailable in the requested scope', async () => {
    const { root } = makeProject();

    const result = await resolveSubagentLaunchContract({ agent: 'absent', cwd: root, agentScope: 'project' });

    expect(result).toEqual({ ok: false, code: 'missing_agent', message: 'Unknown agent: absent' });
  });
});

describe('AgentDiscoveryService caching', () => {
  it('serves repeat lookups without re-reading the filesystem', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'first');

    const service = new TestableDiscoveryService();
    for (let call = 0; call < 20; call++) service.discover(root, 'both');

    // This is the whole point of the service: completion asks per keystroke,
    // and only the first ask may touch the disk.
    expect(service.loadCount).toBe(1);
  });

  it('shares one cache entry across symlinked cwd aliases', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'first');
    const aliasParent = makeTempDir();
    const alias = path.join(aliasParent, 'project-alias');
    fs.symlinkSync(root, alias, 'dir');

    const service = new TestableDiscoveryService();
    service.discover(root, 'both');
    service.discover(alias, 'both');

    expect(service.loadCount).toBe(1);
  });

  it('re-reads once the TTL has passed', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'first');

    const service = new TestableDiscoveryService();
    service.discover(root, 'both');

    writeAgent(agentsDir, 'second');
    fs.utimesSync(agentsDir, new Date(1000), new Date(1000));
    service.advance(5_001);

    expect(service.discover(root, 'both').agents).toHaveLength(2);
  });

  it('re-reads immediately when the directory fingerprint changes', () => {
    // An added file moves the directory mtime, which is the cheap signal that
    // catches the common case well before the TTL would.
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'first');

    const service = new TestableDiscoveryService();
    service.discover(root, 'both');

    writeAgent(agentsDir, 'second');
    fs.utimesSync(agentsDir, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    expect(service.discover(root, 'both').agents).toHaveLength(2);
  });

  it('re-reads immediately when the active layer selection changes', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'worker');
    writeLayers(
      root,
      `layers:
  first:
    packages:
      - name: '@agimon-ai/doompi-team'
        config:
          models:
            - model: model/first
              thinking: high
  second:
    packages:
      - name: '@agimon-ai/doompi-team'
        config:
          models:
            - model: model/second
              thinking: low
majorMode:
  copilot: [first]
`,
    );
    process.env.DOOMPI_ROOT = root;
    process.env.DOOMPI_LAYERS = 'first';
    const service = new TestableDiscoveryService();

    expect(service.discover(root, 'both').agents[0]?.model).toBe('model/first:high');
    // The way /major-mode switches it, rather than by assigning the environment.
    updateHarnessState({ layers: ['second'] });
    expect(service.discover(root, 'both').agents[0]?.model).toBe('model/second:low');
    expect(service.loadCount).toBe(2);
  });

  it('re-reads immediately when modes.yaml changes', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'worker');
    const config = (model: string): string => `layers:
  team:
    packages:
      - name: '@agimon-ai/doompi-team'
        config:
          models:
            - model: ${model}
majorMode:
  copilot: [team]
`;
    writeLayers(root, config('model/first'));
    process.env.DOOMPI_ROOT = root;
    process.env.DOOMPI_LAYERS = 'team';
    const service = new TestableDiscoveryService();

    expect(service.discover(root, 'both').agents[0]?.model).toBe('model/first');
    writeLayers(root, config('model/second'));
    const layersPath = path.join(root, '.doom', 'modes.yaml');
    fs.utimesSync(layersPath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    expect(service.discover(root, 'both').agents[0]?.model).toBe('model/second');
    expect(service.loadCount).toBe(2);
  });

  it('invalidate makes a new agent visible at once', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'first');

    const service = new TestableDiscoveryService();
    service.discover(root, 'both');

    writeAgent(agentsDir, 'second');
    service.invalidate();

    expect(service.discover(root, 'both').agents).toHaveLength(2);
    expect(service.loadCount).toBe(2);
  });

  it('caches each scope separately', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'projectOnly');

    const service = new TestableDiscoveryService();
    expect(service.discover(root, 'user').agents).toHaveLength(0);
    // A shared cache key would return the user-scoped miss here.
    expect(service.discover(root, 'project').agents).toHaveLength(1);
  });

  it('caches each working directory separately', () => {
    const first = makeProject();
    const second = makeProject();
    writeAgent(first.agentsDir, 'alpha');
    writeAgent(second.agentsDir, 'beta');

    const service = new TestableDiscoveryService();
    expect(service.discover(first.root, 'both').agents.map((a) => a.name)).toEqual(['alpha']);
    expect(service.discover(second.root, 'both').agents.map((a) => a.name)).toEqual(['beta']);
  });

  it('does not share cached state between instances', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'first');

    const first = new TestableDiscoveryService();
    first.discover(root, 'both');

    writeAgent(agentsDir, 'second');

    // A fresh instance must do its own read. If this sees one agent, the cache
    // has escaped to module scope, which is the thing this rewrite removed.
    const fresh = new TestableDiscoveryService();
    expect(fresh.discover(root, 'both').agents).toHaveLength(2);
    expect(fresh.loadCount).toBe(1);
  });

  it('hands out a result the caller cannot corrupt', () => {
    const { root, agentsDir } = makeProject();
    writeAgent(agentsDir, 'reviewer');

    const service = new TestableDiscoveryService();
    const first = service.discover(root, 'both');
    first.agents.length = 0;

    // A caller that sorts or splices in place must not affect later readers.
    expect(service.discover(root, 'both').agents).toHaveLength(1);
  });
});
