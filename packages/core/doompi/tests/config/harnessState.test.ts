import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getHarnessState,
  HARNESS_STATE_KEYS,
  harnessRoot,
  projectHarnessEnvironment,
  readHarnessState,
  refreshHarnessState,
  requireHarnessPaths,
  updateHarnessState,
} from '../../src/exports/config/harnessState';

const OWNED_KEYS = Object.values(HARNESS_STATE_KEYS);

afterEach(() => {
  for (const key of OWNED_KEYS) delete process.env[key];
  refreshHarnessState();
});

describe('readHarnessState', () => {
  it('parses a fully populated environment', () => {
    const state = readHarnessState({
      DOOMPI_ROOT: '/repo',
      DOOMPI_MAJOR_MODE: 'marketing',
      DOOMPI_TEMP_DIR: '/tmp/run',
      DOOMPI_DOMAINS: 'marketing,analytics-lite',
      DOOMPI_LAYERS: 'guardrails,goal',
      DOOMPI_PROFILE: 'mai-sales',
      DOOMPI_PROFILE_ENV: JSON.stringify({ SALES_REGION: 'apac' }),
      DOOMPI_HOOK_GROUPS: 'guardrails',
      DOOMPI_SKILL_DIRS: ['/a', '/b'].join(path.delimiter),
      DOOMPI_CHILD_EXTENSIONS: JSON.stringify(['/extensions/persona.mjs', '/extensions/guardrails.mjs']),
      DOOMPI_PLUGIN_DIRS: ['/plugins/a', '/plugins/b'].join(path.delimiter),
      DOOMPI_PLUGIN_HOOKS: JSON.stringify([{ pluginRoot: '/p', configPath: '/p/hooks.json' }]),
      DOOMPI_MCP_CONFIG: '/tmp/run/mcp.yaml',
      DOOMPI_PERSONA_FILE: '/tmp/run/persona.md',
      DOOMPI_HOOKS_ENABLED: '0',
      DOOMPI_AGENTS_ENABLED: '0',
      DOOMPI_MCP_ENABLED: '1',
    });

    expect(state).toEqual({
      root: '/repo',
      majorMode: 'marketing',
      temporaryDirectory: '/tmp/run',
      domains: ['marketing', 'analytics-lite'],
      layers: ['guardrails', 'goal'],
      profile: 'mai-sales',
      profileEnvironment: { SALES_REGION: 'apac' },
      hookGroups: ['guardrails'],
      skillDirectories: ['/a', '/b'],
      agentDirectories: [],
      additionalDirectories: [],
      childExtensions: ['/extensions/persona.mjs', '/extensions/guardrails.mjs'],
      pluginDirectories: ['/plugins/a', '/plugins/b'],
      pluginHooks: [{ pluginRoot: '/p', configPath: '/p/hooks.json' }],
      mcpConfigPath: '/tmp/run/mcp.yaml',
      personaFile: '/tmp/run/persona.md',
      hooks: false,
      agents: false,
      mcp: true,
      allowProtectedWrites: true,
    });
  });

  it('defaults an empty environment without throwing', () => {
    const state = readHarnessState({});
    expect(state.root).toBeUndefined();
    expect(state.majorMode).toBe('copilot');
    expect(state.domains).toEqual([]);
    expect(state.profile).toBeUndefined();
    expect(state.profileEnvironment).toEqual({});
    // Unset flags mean enabled: the launcher only ever writes '0' to disable.
    expect(state.hooks).toBe(true);
    expect(state.agents).toBe(true);
    expect(state.mcp).toBe(true);
  });

  // This distinction gates every guardrail hook. An unset variable is an
  // unmanaged run where all groups load; an empty one is a managed run whose
  // layers selected none, and collapsing the two would load hooks a marketing
  // session deliberately dropped.
  it('separates unset hook groups from empty hook groups', () => {
    expect(readHarnessState({}).hookGroups).toBeUndefined();
    expect(readHarnessState({ DOOMPI_HOOK_GROUPS: '' }).hookGroups).toEqual([]);
    expect(readHarnessState({ DOOMPI_HOOK_GROUPS: 'a,b' }).hookGroups).toEqual(['a', 'b']);
  });

  it('preserves a config-driven layer name from the environment', () => {
    expect(readHarnessState({ DOOMPI_MAJOR_MODE: 'review' }).majorMode).toBe('review');
  });

  it('survives malformed JSON state', () => {
    expect(readHarnessState({ DOOMPI_PLUGIN_HOOKS: '{not json' }).pluginHooks).toEqual([]);
    expect(readHarnessState({ DOOMPI_PLUGIN_HOOKS: '{"a":1}' }).pluginHooks).toEqual([]);
    expect(readHarnessState({ DOOMPI_PROFILE_ENV: '{not json' }).profileEnvironment).toEqual({});
    expect(readHarnessState({ DOOMPI_CHILD_EXTENSIONS: '{not json' }).childExtensions).toEqual([]);
    expect(readHarnessState({ DOOMPI_PROFILE_ENV: '["nope"]' }).profileEnvironment).toEqual({});
    expect(readHarnessState({ DOOMPI_PROFILE_ENV: '{"OK":"yes","NO":2}' }).profileEnvironment).toEqual({
      OK: 'yes',
    });
  });

  it('drops blank entries from lists', () => {
    expect(readHarnessState({ DOOMPI_DOMAINS: 'a, ,b,' }).domains).toEqual(['a', 'b']);
  });
});

describe('projectHarnessEnvironment', () => {
  it('round-trips every field the environment still publishes', () => {
    const state = {
      root: '/repo',
      majorMode: 'dev',
      domains: ['development'],
      layers: ['guardrails'],
      profile: 'editor',
      hookGroups: [] as string[],
      skillDirectories: ['/a', '/b'],
      hooks: false,
      agents: false,
      mcp: true,
    };

    expect(readHarnessState(projectHarnessEnvironment(state, {}))).toMatchObject(state);
  });

  it('keeps the two documents out of the environment a child inherits', () => {
    const environment = projectHarnessEnvironment(
      {
        root: '/repo',
        profileEnvironment: { EDITOR_MODE: 'strict' },
        pluginHooks: [{ pluginRoot: '/p', configPath: '/p/hooks.json' }],
      },
      {},
    );

    expect(environment).toEqual({ DOOMPI_ROOT: '/repo' });
  });

  it('writes only the fields present in the patch', () => {
    const environment = { DOOMPI_ROOT: '/repo' };
    projectHarnessEnvironment({ domains: ['marketing'] }, environment);
    expect(environment).toEqual({ DOOMPI_ROOT: '/repo', DOOMPI_DOMAINS: 'marketing' });
  });

  it('deletes a key when the patch sets it to undefined', () => {
    const environment = { DOOMPI_PERSONA_FILE: '/old/persona.md' };
    projectHarnessEnvironment({ personaFile: undefined }, environment);
    expect(environment).not.toHaveProperty('DOOMPI_PERSONA_FILE');
  });

  it('writes an empty hook group list rather than dropping the key', () => {
    const environment = projectHarnessEnvironment({ hookGroups: [] }, {});
    expect(environment.DOOMPI_HOOK_GROUPS).toBe('');
    expect(readHarnessState(environment).hookGroups).toEqual([]);
  });
});

describe('live state', () => {
  it('reads the environment for a process nobody wrote a state file for', () => {
    process.env.DOOMPI_DOMAINS = 'development';

    expect(refreshHarnessState().domains).toEqual(['development']);
  });

  it('writes through to the environment so a spawned child sees the change', () => {
    updateHarnessState({ domains: ['marketing'], layers: ['goal'] });
    expect(process.env.DOOMPI_DOMAINS).toBe('marketing');
    expect(getHarnessState().layers).toEqual(['goal']);
  });
});

describe('root accessors', () => {
  it('falls back to the cwd when lenient', () => {
    expect(harnessRoot(readHarnessState({}))).toBe(process.cwd());
    expect(harnessRoot(readHarnessState({ DOOMPI_ROOT: '/repo' }))).toBe('/repo');
  });

  it('fails loudly when strict, naming the missing variable', () => {
    expect(() => requireHarnessPaths(readHarnessState({}))).toThrow('DOOMPI_ROOT is not set');
    expect(() => requireHarnessPaths(readHarnessState({ DOOMPI_ROOT: '/repo' }))).toThrow('DOOMPI_TEMP_DIR is not set');
    expect(requireHarnessPaths(readHarnessState({ DOOMPI_ROOT: '/repo', DOOMPI_TEMP_DIR: '/tmp' }))).toEqual({
      root: '/repo',
      temporaryDirectory: '/tmp',
    });
  });
});
