import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyProfileEnvironment,
  buildPersonaPrompt,
  listProfileNames,
  loadProfiles,
  replaceProfileEnvironment,
  resolveProfile,
} from '@agimon-ai/doompi-config/profiles';
import { DOOM_MCP_SESSION_ENV_VAR } from '@agimon-ai/doompi-extension-contracts/mcp-session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeExtensionPlan } from '../../src/adapters/runtimeBundle.ts';
import type { HarnessOptions } from '../../src/types/interfaces/harness';
import { buildHarnessContext, resolveHarnessProfile } from '../../src/exports/services/harnessContext';

let root: string;

function writeProfiles(body: string): void {
  fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
  fs.writeFileSync(path.join(root, '.doom', 'profiles.yaml'), body);
}

function writeManagedExtensionPackage(name: string): void {
  const packageRoot = path.join(root, '.pi', 'npm', 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(packageRoot, 'dist', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'dist', 'extensions', 'pi.mjs'), 'export default () => undefined;\n');
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name, type: 'module', pi: { extensions: ['./dist/extensions/pi.mjs'] } }),
  );
}

function baseOptions(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    repoRoot: root,
    cwd: root,
    domains: ['development'],
    majorMode: 'copilot',
    explain: false,
    pluginDirectories: [],
    additionalDirectories: [],
    preset: 'default',
    outputFormat: 'native',
    mute: false,
    automation: false,
    autoStop: false,
    sandbox: false,
    allowProtectedWrites: false,
    hooks: true,
    mcp: true,
    agents: true,
    piArgs: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profile-'));
  fs.mkdirSync(path.join(root, 'agents', 'acme', 'ada'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'acme', 'ada', 'profile.md'), 'Title: Editor');
  fs.writeFileSync(path.join(root, 'agents', 'acme', 'ada', 'SOUL.md'), 'Never invent metrics.');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('profile configuration', () => {
  it('loads sorted persona and environment profiles from one file', () => {
    writeProfiles(`
profiles:
  writer:
    persona: agents/acme/ada
    env: {}
  editor:
    persona: agents/acme/ada
    env:
      EDITOR_MODE: strict
`);

    expect(loadProfiles(root)).toEqual([
      { name: 'editor', persona: 'agents/acme/ada', personaRoot: root, env: { EDITOR_MODE: 'strict' } },
      { name: 'writer', persona: 'agents/acme/ada', personaRoot: root, env: {} },
    ]);
    expect(listProfileNames(root)).toEqual(['editor', 'writer']);
    expect(resolveProfile(root, 'editor').env).toEqual({ EDITOR_MODE: 'strict' });
  });

  it('discovers profiles from configured direct-child folders', () => {
    const profilesRoot = path.join(root, 'personas');
    fs.mkdirSync(path.join(profilesRoot, 'reviewer'), { recursive: true });
    fs.writeFileSync(path.join(profilesRoot, 'reviewer', 'AGENTS.md'), 'Review carefully.');
    writeProfiles('profiles:\n  roots: [personas]\n  entries: {}\n');

    expect(loadProfiles(root)).toEqual([
      { name: 'reviewer', persona: 'personas/reviewer', personaRoot: root, env: {} },
    ]);
  });

  it('returns no profiles when the file is absent', () => {
    expect(loadProfiles(root)).toEqual([]);
    expect(() => resolveProfile(root, 'missing')).toThrow('Unknown profile: missing');
  });

  it('rejects fields other than persona and env', () => {
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/ada\n    domains: [development]\n');
    expect(() => loadProfiles(root)).toThrow('may only set persona and env');
  });

  it('requires a repository-local persona with readable files', () => {
    writeProfiles('profiles:\n  editor:\n    env: {}\n');
    expect(() => loadProfiles(root)).toThrow('must set a persona');

    writeProfiles('profiles:\n  editor:\n    persona: /tmp/persona\n');
    expect(() => loadProfiles(root)).toThrow('relative to the config that declares it');

    writeProfiles('profiles:\n  editor:\n    persona: ../outside\n');
    expect(() => loadProfiles(root)).toThrow('inside agents/');

    fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'personas', 'profile.md'), '# Wrong directory');
    writeProfiles('profiles:\n  editor:\n    persona: personas\n');
    expect(() => loadProfiles(root)).toThrow('inside agents/');

    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/missing\n');
    expect(() => loadProfiles(root)).toThrow('missing persona');

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-persona-'));
    try {
      fs.writeFileSync(path.join(outside, 'profile.md'), '# Outside');
      fs.symlinkSync(outside, path.join(root, 'agents', 'acme', 'linked'), 'dir');
      writeProfiles('profiles:\n  editor:\n    persona: agents/acme/linked\n');
      expect(() => loadProfiles(root)).toThrow('inside agents/');

      const linkedFilePersona = path.join(root, 'agents', 'acme', 'linked-file');
      fs.mkdirSync(linkedFilePersona);
      fs.symlinkSync(path.join(outside, 'profile.md'), path.join(linkedFilePersona, 'profile.md'));
      writeProfiles('profiles:\n  editor:\n    persona: agents/acme/linked-file\n');
      expect(() => loadProfiles(root)).toThrow('Persona file must stay inside');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }

    fs.mkdirSync(path.join(root, 'agents', 'acme', 'empty'), { recursive: true });
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/empty\n');
    expect(() => loadProfiles(root)).toThrow('no readable persona files');
  });

  it('requires a profiles mapping and string environment values', () => {
    writeProfiles('profiles: []\n');
    expect(() => loadProfiles(root)).toThrow('must contain a profiles mapping');

    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/ada\n    env: nope\n');
    expect(() => loadProfiles(root)).toThrow('env must be a string mapping');

    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/ada\n    env:\n      RETRIES: 2\n');
    expect(() => loadProfiles(root)).toThrow('env.RETRIES must be a string');

    writeProfiles('profiles: {}\nunexpected: true\n');
    expect(() => loadProfiles(root)).toThrow('may only contain profiles');
  });
});

describe('persona prompt', () => {
  it('concatenates the persona files that exist', () => {
    const prompt = buildPersonaPrompt(root, 'agents/acme/ada');
    expect(prompt).toContain('Title: Editor');
    expect(prompt).toContain('Never invent metrics.');
    expect(prompt).toContain('agents/acme/ada');
  });

  it('returns undefined when no persona files contain text', () => {
    fs.mkdirSync(path.join(root, 'agents', 'acme', 'empty'), { recursive: true });
    expect(buildPersonaPrompt(root, 'agents/acme/empty')).toBeUndefined();
  });
});

describe('profile environment', () => {
  it('uses profile values only as defaults', () => {
    const environment = { EXISTING: 'caller' };
    const applied = applyProfileEnvironment(environment, { EXISTING: 'profile', ADDED: 'profile' });

    expect(environment).toEqual({ EXISTING: 'caller', ADDED: 'profile' });
    expect(applied).toEqual({ ADDED: 'profile' });
  });

  it('replaces only values contributed by the previous profile', () => {
    const environment = { OLD: 'old-profile', CALLER: 'caller' };
    const applied = replaceProfileEnvironment(
      environment,
      { OLD: 'old-profile' },
      { OLD: 'new-profile', CALLER: 'new-profile', ADDED: 'new-profile' },
    );

    expect(environment).toEqual({ OLD: 'new-profile', CALLER: 'caller', ADDED: 'new-profile' });
    expect(applied).toEqual({ OLD: 'new-profile', ADDED: 'new-profile' });
  });
});

describe('resolveHarnessProfile', () => {
  it('resolves only the singular selected profile without changing domains', () => {
    writeProfiles('profiles:\n  editor:\n    persona: agents/acme/ada\n    env:\n      EDITOR_MODE: strict\n');
    const options = baseOptions({ profile: 'editor', domains: ['development', 'qa'] });

    expect(resolveHarnessProfile(options)).toEqual({
      name: 'editor',
      persona: 'agents/acme/ada',
      personaRoot: root,
      env: { EDITOR_MODE: 'strict' },
    });
    expect(options.domains).toEqual(['development', 'qa']);
  });

  it('returns undefined when no profile is selected', () => {
    expect(resolveHarnessProfile(baseOptions())).toBeUndefined();
  });

  it('keeps layer-owned MCP and Workflow factories when MCP projection is disabled', async () => {
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.doom', 'domains.yaml'),
      'domains:\n  development:\n    plugins: []\naliases: {}\n',
    );
    fs.writeFileSync(
      path.join(root, '.doom', 'modes.yaml'),
      `layers:
  workflow:
    packages: ["@agimon-ai/doompi-workflow"]
  mcp:
    packages: ["@agimon-ai/doompi-mcp"]
defaultMajorMode: copilot
majorMode:
  copilot:
    description: Test feature composition.
    layers: [workflow, mcp]
`,
    );
    writeManagedExtensionPackage('@agimon-ai/doompi-workflow');
    writeManagedExtensionPackage('@agimon-ai/doompi-mcp');
    const inheritedMcpSession = process.env[DOOM_MCP_SESSION_ENV_VAR];
    process.env[DOOM_MCP_SESSION_ENV_VAR] = 'stale-parent-projection';

    const context = await buildHarnessContext(baseOptions({ mcp: false }));
    try {
      const plan = createRuntimeExtensionPlan(context);
      expect(plan.extensions.some((entry) => entry.includes('@agimon-ai/doompi-workflow'))).toBe(true);
      expect(plan.extensions.some((entry) => entry.includes('@agimon-ai/doompi-mcp'))).toBe(true);
      expect(plan.childExtensions.some((entry) => entry.includes('@agimon-ai/doompi-workflow'))).toBe(true);
      expect(plan.childExtensions.some((entry) => entry.includes('@agimon-ai/doompi-mcp'))).toBe(true);
      expect(context.environment[DOOM_MCP_SESSION_ENV_VAR]).toBeUndefined();

      const dispatcher = fs.readFileSync(
        path.join(context.resources.agentDirectories[0]!, 'agiflow-dispatcher.md'),
        'utf8',
      );
      expect(dispatcher).toContain('name: agiflow-dispatcher');
      expect(dispatcher).not.toContain('@agimon-ai/doompi-workflow');
      expect(dispatcher).not.toContain('extensions:');
    } finally {
      await context.cleanup();
      if (inheritedMcpSession === undefined) delete process.env[DOOM_MCP_SESSION_ENV_VAR];
      else process.env[DOOM_MCP_SESSION_ENV_VAR] = inheritedMcpSession;
    }
  });

  it('clears an inherited persona file when no profile is selected', async () => {
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.doom', 'domains.yaml'),
      'domains:\n  development:\n    plugins: []\naliases: {}\n',
    );
    fs.writeFileSync(path.join(root, '.doom', 'modes.yaml'), 'layers: {}\nmajorMode:\n  copilot: []\n');
    process.env.DOOMPI_PERSONA_FILE = '/tmp/stale-persona.md';
    const inheritedNxDaemon = process.env.NX_DAEMON;
    delete process.env.NX_DAEMON;

    const context = await buildHarnessContext(baseOptions({ mcp: false, agents: false }));
    try {
      expect(context.environment.DOOMPI_PERSONA_FILE).toBeUndefined();
      expect(context.environment.NX_DAEMON).toBe('false');
      expect(context.profile).toBeUndefined();
    } finally {
      await context.cleanup();
      delete process.env.DOOMPI_PERSONA_FILE;
      if (inheritedNxDaemon === undefined) delete process.env.NX_DAEMON;
      else process.env.NX_DAEMON = inheritedNxDaemon;
    }
  });
});
