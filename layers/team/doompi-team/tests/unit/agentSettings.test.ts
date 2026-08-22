import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentHasFrontmatterField,
  applyBuiltinOverride,
  applyBuiltinOverrides,
  applyCustomAgentOverride,
  applyCustomAgentOverrides,
  applySubagentDefaultExtensions,
  applySubagentDefaultFallbackModels,
  applySubagentDefaultModel,
  applySubagentDefaults,
  applySubagentDefaultThinking,
  buildBuiltinOverrideConfig,
  type BuiltinOverrideSnapshot,
  clearBuiltinThinking,
  cloneOverrideBase,
  cloneOverrideValue,
  EMPTY_SUBAGENT_SETTINGS,
  mergeBuiltinAgentOverride,
  parseBuiltinOverrideEntry,
  parseOverrideStringArrayOrFalse,
  readSettingsFileStrict,
  readSubagentSettings,
  removeBuiltinAgentOverride,
  removeBuiltinAgentOverrideFields,
  resolveSubagentDefaultExtensions,
  resolveSubagentDefaultModel,
  resolveSubagentDefaultThinking,
  saveBuiltinAgentOverride,
  setAgentFrontmatterFields,
  writeSettingsFile,
} from '../../src/adapters/agents/settings';
import type {
  AgentConfig,
  AgentModelSourceInfo,
  BuiltinAgentOverrideConfig,
  SubagentSettings,
} from '../../src/adapters/agents/types';
import { getProjectConfigDir } from '../../src/adapters/filesystem/configDir';

const SETTINGS_FILE_NAME = 'settings.json';

const temporaryDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-settings-'));
  temporaryDirs.push(dir);
  return dir;
}

/** Stands in for the user's config dir, so no test can touch the real one. */
let userDir: string;
let userSettingsPath: string;

beforeEach(() => {
  userDir = makeTempDir();
  userSettingsPath = path.join(userDir, SETTINGS_FILE_NAME);
  process.env.PI_CODING_AGENT_DIR = userDir;
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A directory the project-root walk will accept.
 *
 * The config directory has to exist for the walk to recognise the root, but the
 * settings file itself must not, so the absent-file branches stay reachable.
 */
function makeProjectRoot(): { cwd: string; settingsPath: string } {
  const cwd = makeTempDir();
  const configDir = getProjectConfigDir(cwd);
  fs.mkdirSync(configDir, { recursive: true });
  return { cwd, settingsPath: path.join(configDir, SETTINGS_FILE_NAME) };
}

function writeJson(filePath: string, value: unknown): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'reviewer',
    description: 'reviews code',
    systemPromptMode: 'append',
    inheritProjectContext: true,
    inheritSkills: true,
    systemPrompt: 'be careful',
    source: 'plugin',
    filePath: '/agents/reviewer.md',
    ...overrides,
  };
}

function makeSettings(overrides: Partial<SubagentSettings> = {}): SubagentSettings {
  return { overrides: {}, ...overrides };
}

/** Reads better than a non-null assertion at every single-agent call site. */
function only(agents: AgentConfig[]): AgentConfig {
  const [agent] = agents;
  if (!agent) throw new Error('expected exactly one agent');
  return agent;
}

// ============================================================================
// Reading
// ============================================================================

describe('readSettingsFileStrict', () => {
  it('treats an absent file as empty, since having configured nothing is normal', () => {
    expect(readSettingsFileStrict(path.join(makeTempDir(), 'missing.json'))).toEqual({});
  });

  it('throws with the offending path when the file cannot be read', () => {
    // A directory where a file is expected exists but cannot be read, which is
    // the case that must not be mistaken for "no settings configured".
    const filePath = path.join(makeTempDir(), SETTINGS_FILE_NAME);
    fs.mkdirSync(filePath);

    expect(() => readSettingsFileStrict(filePath)).toThrow(`Failed to read settings file '${filePath}'`);
  });

  it('throws with the offending path when the file is not JSON', () => {
    const filePath = path.join(makeTempDir(), SETTINGS_FILE_NAME);
    fs.writeFileSync(filePath, '{ not json');

    expect(() => readSettingsFileStrict(filePath)).toThrow(`Failed to parse settings file '${filePath}'`);
  });

  it('rejects valid JSON that is not an object, which cannot hold settings', () => {
    const arrayPath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), ['subagents']);
    const nullPath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), null);
    const numberPath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), 7);

    expect(() => readSettingsFileStrict(arrayPath)).toThrow(`Settings file '${arrayPath}' must contain a JSON object.`);
    expect(() => readSettingsFileStrict(nullPath)).toThrow(`Settings file '${nullPath}' must contain a JSON object.`);
    expect(() => readSettingsFileStrict(numberPath)).toThrow(
      `Settings file '${numberPath}' must contain a JSON object.`,
    );
  });

  it('returns the parsed object untouched, including keys it does not interpret', () => {
    const filePath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), { subagents: {}, somethingElse: 1 });
    expect(readSettingsFileStrict(filePath)).toEqual({ subagents: {}, somethingElse: 1 });
  });
});

describe('writeSettingsFile', () => {
  it('reads back exactly what was written', () => {
    const filePath = path.join(makeTempDir(), SETTINGS_FILE_NAME);
    const settings = { subagents: { agentOverrides: { reviewer: { model: 'opus' } } }, other: [1, 2] };

    writeSettingsFile(filePath, settings);

    expect(readSettingsFileStrict(filePath)).toEqual(settings);
  });

  it('creates the containing directory, so a first-ever save is not a failure', () => {
    const filePath = path.join(makeTempDir(), 'nested', 'deeper', SETTINGS_FILE_NAME);
    writeSettingsFile(filePath, { a: 1 });
    expect(readSettingsFileStrict(filePath)).toEqual({ a: 1 });
  });

  it('leaves no temp file behind, so a later read never picks up a half-written copy', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, SETTINGS_FILE_NAME);

    writeSettingsFile(filePath, { a: 1 });
    writeSettingsFile(filePath, { a: 2 });

    expect(fs.readdirSync(dir)).toEqual([SETTINGS_FILE_NAME]);
    expect(readSettingsFileStrict(filePath)).toEqual({ a: 2 });
  });
});

describe('readSubagentSettings', () => {
  it('returns the shared empty settings when there is no file to read', () => {
    expect(readSubagentSettings(null)).toBe(EMPTY_SUBAGENT_SETTINGS);
    expect(readSubagentSettings(path.join(makeTempDir(), 'missing.json'))).toBe(EMPTY_SUBAGENT_SETTINGS);
  });

  it('returns the shared empty settings when the subagents block is absent or not an object', () => {
    const absent = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), { other: true });
    const wrongShape = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), { subagents: ['nope'] });

    expect(readSubagentSettings(absent)).toBe(EMPTY_SUBAGENT_SETTINGS);
    expect(readSubagentSettings(wrongShape)).toBe(EMPTY_SUBAGENT_SETTINGS);
  });

  it('parses every settings-level field', () => {
    const filePath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), {
      subagents: {
        disableBuiltins: true,
        disableThinking: false,
        defaultModel: '  opus  ',
        defaultThinking: ' high ',
        defaultExtensions: [' ext-a ', 'ext-b'],
        modelScope: { enforce: true, allow: ['opus*', ' haiku* '] },
        agentOverrides: { reviewer: { model: 'haiku' } },
      },
    });

    expect(readSubagentSettings(filePath)).toEqual({
      overrides: { reviewer: { model: 'haiku' } },
      defaultModel: 'opus',
      defaultThinking: 'high',
      defaultExtensions: ['ext-a', 'ext-b'],
      disableBuiltins: true,
      disableThinking: false,
      modelScope: { enforce: true, allow: ['opus*', 'haiku*'] },
    });
  });

  it('leaves unset settings undefined rather than inventing defaults', () => {
    const filePath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), { subagents: {} });

    expect(readSubagentSettings(filePath)).toEqual({
      overrides: {},
      defaultModel: undefined,
      defaultThinking: undefined,
      defaultExtensions: undefined,
      disableBuiltins: undefined,
      disableThinking: undefined,
      modelScope: undefined,
    });
  });

  it.each([
    ['disableBuiltins', { disableBuiltins: 'yes' }, "invalid 'disableBuiltins'"],
    ['disableThinking', { disableThinking: 1 }, "invalid 'disableThinking'"],
    ['defaultModel as a non-string', { defaultModel: 5 }, "invalid 'defaultModel'"],
    ['defaultModel as blank', { defaultModel: '   ' }, "invalid 'defaultModel'"],
    ['defaultThinking as blank', { defaultThinking: '' }, "invalid 'defaultThinking'"],
    ['defaultExtensions as a string', { defaultExtensions: 'ext' }, "invalid 'defaultExtensions'"],
    ['defaultExtensions with a blank entry', { defaultExtensions: ['ok', ' '] }, "invalid 'defaultExtensions'"],
    ['modelScope as an array', { modelScope: [] }, "invalid 'modelScope'"],
    ['modelScope.enforce as a string', { modelScope: { enforce: 'yes' } }, "invalid 'modelScope.enforce'"],
    ['modelScope.allow as a string', { modelScope: { allow: 'opus' } }, "invalid 'modelScope.allow'"],
    ['modelScope.allow with a number', { modelScope: { allow: [1] } }, "invalid 'modelScope.allow'"],
    ['modelScope.allow all blank', { modelScope: { allow: ['  '] } }, "invalid 'modelScope.allow'"],
  ])('refuses to half-load settings with %s', (_case, subagents, message) => {
    const filePath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), { subagents });
    expect(() => readSubagentSettings(filePath)).toThrow(message);
  });

  it('rejects enforcing a model scope with no allow list, which would reject every model', () => {
    const filePath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), {
      subagents: { modelScope: { enforce: true } },
    });
    expect(() => readSubagentSettings(filePath)).toThrow('without a non-empty');
  });

  it('drops a model scope that declared nothing', () => {
    const filePath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), { subagents: { modelScope: {} } });
    expect(readSubagentSettings(filePath).modelScope).toBeUndefined();
  });

  it('ignores an agentOverrides block that is not an object', () => {
    const filePath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), {
      subagents: { agentOverrides: ['reviewer'] },
    });
    expect(readSubagentSettings(filePath).overrides).toEqual({});
  });

  it('does not register an entry that declared nothing, so the agent is not reported as overridden', () => {
    const filePath = writeJson(path.join(makeTempDir(), SETTINGS_FILE_NAME), {
      subagents: { agentOverrides: { reviewer: {}, writer: { unknownKey: 'ignored' } } },
    });
    expect(readSubagentSettings(filePath).overrides).toEqual({});
  });
});

describe('parseOverrideStringArrayOrFalse', () => {
  const meta = { filePath: '/settings.json', name: 'reviewer', field: 'skills' };

  it('distinguishes absent from cleared', () => {
    expect(parseOverrideStringArrayOrFalse(undefined, meta)).toBeUndefined();
    expect(parseOverrideStringArrayOrFalse(false, meta)).toBe(false);
  });

  it('drops blank entries, because a trailing comma in a hand-edited list is unambiguous', () => {
    expect(parseOverrideStringArrayOrFalse(['a', '  ', ' b '], meta)).toEqual(['a', 'b']);
  });

  it('rejects anything that is not an array of strings', () => {
    expect(() => parseOverrideStringArrayOrFalse('a', meta)).toThrow("has invalid 'skills'");
    expect(() => parseOverrideStringArrayOrFalse([1], meta)).toThrow("has invalid 'skills'");
    expect(() => parseOverrideStringArrayOrFalse(true, meta)).toThrow("has invalid 'skills'");
  });
});

describe('parseBuiltinOverrideEntry', () => {
  const filePath = '/settings.json';

  it('parses every supported field', () => {
    const parsed = parseBuiltinOverrideEntry(
      'reviewer',
      {
        model: 'opus',
        thinking: 'high',
        systemPromptMode: 'replace',
        inheritProjectContext: false,
        inheritSkills: true,
        defaultContext: 'fork',
        disabled: true,
        completionGuard: false,
        systemPrompt: 'do the thing',
        toolBudget: { hard: 20, soft: 10, block: ['Bash'] },
        fallbackModels: ['haiku'],
        skills: ['review'],
        tools: ['Read', 'mcp:pencil__browser'],
        extensions: ['ext-a'],
        subagentOnlyExtensions: ['ext-b'],
      },
      filePath,
    );

    expect(parsed).toEqual({
      model: 'opus',
      thinking: 'high',
      systemPromptMode: 'replace',
      inheritProjectContext: false,
      inheritSkills: true,
      defaultContext: 'fork',
      disabled: true,
      completionGuard: false,
      systemPrompt: 'do the thing',
      toolBudget: { hard: 20, soft: 10, block: ['Bash'] },
      fallbackModels: ['haiku'],
      skills: ['review'],
      tools: ['Read', 'mcp:pencil__browser'],
      extensions: ['ext-a'],
      subagentOnlyExtensions: ['ext-b'],
    });
  });

  it('accepts false for the fields that support clearing', () => {
    expect(
      parseBuiltinOverrideEntry(
        'reviewer',
        {
          model: false,
          thinking: false,
          defaultContext: false,
          toolBudget: false,
          tools: false,
        },
        filePath,
      ),
    ).toEqual({
      model: false,
      thinking: false,
      defaultContext: false,
      toolBudget: false,
      tools: false,
    });
  });

  it('returns undefined for an entry that declared nothing', () => {
    expect(parseBuiltinOverrideEntry('reviewer', {}, filePath)).toBeUndefined();
    expect(parseBuiltinOverrideEntry('reviewer', { notAKnownField: 1 }, filePath)).toBeUndefined();
  });

  it.each([
    ['a string', 'nope'],
    ['an array', []],
    ['null', null],
  ])('rejects an entry that is %s', (_case, value) => {
    expect(() => parseBuiltinOverrideEntry('reviewer', value, filePath)).toThrow(
      `Builtin override 'reviewer' in '${filePath}' must be an object.`,
    );
  });

  it.each([
    ['model', { model: 1 }, "invalid 'model'"],
    ['thinking', { thinking: true }, "invalid 'thinking'"],
    ['systemPromptMode', { systemPromptMode: 'merge' }, "invalid 'systemPromptMode'"],
    ['inheritProjectContext', { inheritProjectContext: 'yes' }, "invalid 'inheritProjectContext'"],
    ['inheritSkills', { inheritSkills: 'yes' }, "invalid 'inheritSkills'"],
    ['defaultContext', { defaultContext: 'clone' }, "invalid 'defaultContext'"],
    ['disabled', { disabled: 'yes' }, "invalid 'disabled'"],
    ['completionGuard', { completionGuard: 'yes' }, "invalid 'completionGuard'"],
    ['systemPrompt', { systemPrompt: 12 }, "invalid 'systemPrompt'"],
    ['toolBudget', { toolBudget: 'lots' }, "invalid 'toolBudget'"],
    ['toolBudget.hard', { toolBudget: { soft: 1 } }, "invalid 'toolBudget.hard'"],
    ['toolBudget.soft', { toolBudget: { hard: 2, soft: 'x' } }, "invalid 'toolBudget.soft'"],
    ['toolBudget.block', { toolBudget: { hard: 2, block: 'Bash' } }, "invalid 'toolBudget.block'"],
    ['toolBudget.block entries', { toolBudget: { hard: 2, block: [1] } }, "invalid 'toolBudget.block'"],
    ['fallbackModels', { fallbackModels: 'haiku' }, "invalid 'fallbackModels'"],
  ])('rejects a malformed %s', (_case, value, message) => {
    expect(() => parseBuiltinOverrideEntry('reviewer', value, filePath)).toThrow(message);
  });

  it('accepts a wildcard tool budget block list', () => {
    expect(parseBuiltinOverrideEntry('reviewer', { toolBudget: { hard: 5, block: '*' } }, filePath)).toEqual({
      toolBudget: { hard: 5, block: '*' },
    });
  });

  it('copies the block list, so a later edit of the parsed value cannot reach the source', () => {
    const block = ['Bash'];
    const parsed = parseBuiltinOverrideEntry('reviewer', { toolBudget: { hard: 5, block } }, filePath);
    block.push('Write');
    expect(parsed?.toolBudget).toEqual({ hard: 5, block: ['Bash'] });
  });
});

// ============================================================================
// Settings-level defaults
// ============================================================================

describe('resolving settings-level defaults', () => {
  it('lets project settings beat user settings for the default model', () => {
    const resolved = resolveSubagentDefaultModel(
      makeSettings({ defaultModel: 'user-model' }),
      makeSettings({ defaultModel: 'project-model' }),
      userSettingsPath,
      '/repo/.pi/settings.json',
    );

    expect(resolved).toEqual({
      type: 'subagents.defaultModel',
      scope: 'project',
      path: '/repo/.pi/settings.json',
      model: 'project-model',
    });
  });

  it('falls back to the user default when there is no project file at all', () => {
    // A project-shaped settings object with no path behind it must not win, or a
    // stale parse would beat the user's real configuration.
    const resolved = resolveSubagentDefaultModel(
      makeSettings({ defaultModel: 'user-model' }),
      makeSettings({ defaultModel: 'project-model' }),
      userSettingsPath,
      null,
    );

    expect(resolved).toEqual({
      type: 'subagents.defaultModel',
      scope: 'user',
      path: userSettingsPath,
      model: 'user-model',
    });
  });

  it('falls back to the user default when the project file set no model', () => {
    const resolved = resolveSubagentDefaultModel(
      makeSettings({ defaultModel: 'user-model' }),
      makeSettings(),
      userSettingsPath,
      '/repo/.pi/settings.json',
    );
    expect(resolved?.scope).toBe('user');
  });

  it('resolves to nothing when neither file set a model', () => {
    expect(resolveSubagentDefaultModel(makeSettings(), makeSettings(), userSettingsPath, null)).toBeUndefined();
  });

  it('applies the same precedence to thinking and extensions', () => {
    const user = makeSettings({ defaultThinking: 'low', defaultExtensions: ['user-ext'] });
    const project = makeSettings({ defaultThinking: 'high', defaultExtensions: ['project-ext'] });

    expect(resolveSubagentDefaultThinking(user, project, '/repo/.pi/settings.json')).toBe('high');
    expect(resolveSubagentDefaultThinking(user, project, null)).toBe('low');
    expect(resolveSubagentDefaultExtensions(user, project, '/repo/.pi/settings.json')).toEqual(['project-ext']);
    expect(resolveSubagentDefaultExtensions(user, project, null)).toEqual(['user-ext']);
    expect(resolveSubagentDefaultThinking(makeSettings(), makeSettings(), null)).toBeUndefined();
    expect(resolveSubagentDefaultExtensions(makeSettings(), makeSettings(), null)).toBeUndefined();
  });
});

describe('applying settings-level defaults', () => {
  const modelSource: AgentModelSourceInfo = {
    type: 'subagents.defaultModel',
    scope: 'user',
    path: '/home/.pi/agent/settings.json',
    model: 'default-model',
  };

  it('fills a model only for agents that declared none, and records where it came from', () => {
    const declared = makeAgent({ name: 'declared', model: 'own-model' });
    const undeclared = makeAgent({ name: 'undeclared' });

    const [first, second] = applySubagentDefaultModel([declared, undeclared], modelSource);

    expect(first).toBe(declared);
    expect(second?.model).toBe('default-model');
    expect(second?.modelSource).toEqual(modelSource);
  });

  it('does nothing at all when there is no default, keeping the cached array identity', () => {
    const agents = [makeAgent()];
    expect(applySubagentDefaultModel(agents, undefined)).toBe(agents);
    expect(applySubagentDefaultFallbackModels(agents, undefined)).toBe(agents);
    expect(applySubagentDefaultThinking(agents, undefined)).toBe(agents);
    expect(applySubagentDefaultExtensions(agents, undefined)).toBe(agents);
  });

  it('treats an explicitly disabled thinking level as declared', () => {
    // `false` means the author turned thinking off; a default must not undo that.
    const agent = makeAgent({ thinking: false });
    expect(only(applySubagentDefaultThinking([agent], 'high'))).toBe(agent);
  });

  it('leaves an agent that declared its own extensions alone', () => {
    const agent = makeAgent({ extensions: ['own-ext'] });
    const next = only(applySubagentDefaultExtensions([agent], ['ext-a']));

    expect(next).toBe(agent);
    expect(next.extensionsFromDefault).toBeUndefined();
  });

  it('marks default extensions as such, so a later snapshot does not bake them in', () => {
    const agent = makeAgent();
    const next = only(applySubagentDefaultExtensions([agent], ['ext-a']));

    expect(next.extensions).toEqual(['ext-a']);
    expect(next.extensionsFromDefault).toBe(true);
    expect(cloneOverrideBase(next).extensions).toBeUndefined();
  });

  it("copies the default extensions, so one agent cannot edit another agent's list", () => {
    const defaults = ['ext-a'];
    const [first, second] = applySubagentDefaultExtensions(
      [makeAgent({ name: 'a' }), makeAgent({ name: 'b' })],
      defaults,
    );

    first?.extensions?.push('mutated');
    expect(second?.extensions).toEqual(['ext-a']);
    expect(defaults).toEqual(['ext-a']);
  });

  it('fills and copies fallback models only for agents without their own list', () => {
    const declared = makeAgent({ name: 'declared', fallbackModels: ['own-fallback'] });
    const inherited = makeAgent({ name: 'inherited' });
    const defaults = ['fallback-a', 'fallback-b'];

    const [first, second] = applySubagentDefaultFallbackModels([declared, inherited], defaults);

    expect(first).toBe(declared);
    expect(second?.fallbackModels).toEqual(defaults);
    expect(second?.fallbackModels).not.toBe(defaults);
  });

  it('never mutates the agents it was handed, because discovery hands over a cached array', () => {
    const agents = [makeAgent({ name: 'a' }), makeAgent({ name: 'b', model: 'own' })];
    const before = JSON.stringify(agents);

    applySubagentDefaults(agents, modelSource, 'high', ['ext-a']);

    expect(JSON.stringify(agents)).toBe(before);
    expect(agents).toHaveLength(2);
  });

  it('applies all defaults in one pass', () => {
    const next = only(applySubagentDefaults([makeAgent()], modelSource, 'high', ['ext-a'], ['fallback-a']));

    expect(next.model).toBe('default-model');
    expect(next.fallbackModels).toEqual(['fallback-a']);
    expect(next.thinking).toBe('high');
    expect(next.extensions).toEqual(['ext-a']);
  });

  it('carries the frontmatter record onto every copy it makes', () => {
    // Each pass produces a new object; if the record did not follow, a later
    // custom-agent override would think the author had declared nothing.
    const agent = makeAgent({ thinking: 'high' });
    setAgentFrontmatterFields(agent, new Set(['thinking']));

    const next = only(applySubagentDefaults([agent], modelSource, 'low', ['ext-a']));

    expect(agentHasFrontmatterField(next, 'thinking')).toBe(true);
  });
});

describe('agentHasFrontmatterField', () => {
  it('reports nothing declared for an agent that was never recorded', () => {
    expect(agentHasFrontmatterField(makeAgent(), 'model')).toBe(false);
  });

  it('matches when any of the given names was declared, since a field may be spelled two ways', () => {
    const agent = makeAgent();
    setAgentFrontmatterFields(agent, new Set(['skill']));

    expect(agentHasFrontmatterField(agent, 'skill', 'skills')).toBe(true);
    expect(agentHasFrontmatterField(agent, 'skills')).toBe(false);
    expect(agentHasFrontmatterField(agent, 'model')).toBe(false);
  });
});

// ============================================================================
// Snapshots and clones
// ============================================================================

describe('cloneOverrideBase', () => {
  it('deep-copies every array, so restoring cannot be corrupted by a later edit', () => {
    const agent = makeAgent({
      fallbackModels: ['haiku'],
      skills: ['review'],
      skillPath: ['/skills'],
      tools: ['Read'],
      mcpDirectTools: ['pencil__browser'],
      extensions: ['ext-a'],
      subagentOnlyExtensions: ['ext-b'],
    });

    const snapshot = cloneOverrideBase(agent);
    agent.tools?.push('Write');
    agent.skills?.push('other');

    expect(snapshot.tools).toEqual(['Read']);
    expect(snapshot.skills).toEqual(['review']);
    expect(snapshot.mcpDirectTools).toEqual(['pencil__browser']);
  });

  it('round-trips a split tool list, which a plain override base could not represent', () => {
    const snapshot = cloneOverrideBase(makeAgent({ tools: ['Read'], mcpDirectTools: ['pencil__browser'] }));
    expect(snapshot.tools).toEqual(['Read']);
    expect(snapshot.mcpDirectTools).toEqual(['pencil__browser']);
  });
});

describe('cloneOverrideValue', () => {
  it('omits keys the caller never set, so serialising cannot turn them into "not overridden"', () => {
    expect(Object.keys(cloneOverrideValue({ model: 'opus' }))).toEqual(['model']);
    expect(cloneOverrideValue({})).toEqual({});
  });

  it('carries every set key through unchanged', () => {
    const source: BuiltinAgentOverrideConfig = {
      model: 'opus',
      thinking: 'high',
      systemPromptMode: 'replace',
      inheritProjectContext: false,
      inheritSkills: true,
      defaultContext: 'fork',
      disabled: true,
      systemPrompt: 'do the thing',
      completionGuard: false,
    };

    expect(cloneOverrideValue(source)).toEqual(source);
  });

  it('keeps false, which is a real value meaning "clear it"', () => {
    const cloned = cloneOverrideValue({
      model: false,
      fallbackModels: false,
      skills: false,
      tools: false,
      extensions: false,
      subagentOnlyExtensions: false,
      toolBudget: false,
    });

    expect(cloned).toEqual({
      model: false,
      fallbackModels: false,
      skills: false,
      tools: false,
      extensions: false,
      subagentOnlyExtensions: false,
      toolBudget: false,
    });
  });

  it('deep-copies arrays and the tool budget', () => {
    const source: BuiltinAgentOverrideConfig = {
      fallbackModels: ['haiku'],
      skills: ['review'],
      tools: ['Read'],
      extensions: ['ext-a'],
      subagentOnlyExtensions: ['ext-b'],
      toolBudget: { hard: 5, block: ['Bash'] },
    };

    const cloned = cloneOverrideValue(source);
    source.tools = ['Write'];
    const budget = source.toolBudget;
    if (budget && Array.isArray(budget.block)) budget.block.push('Read');

    expect(cloned.tools).toEqual(['Read']);
    expect(cloned.toolBudget).toEqual({ hard: 5, block: ['Bash'] });
  });

  it('carries a wildcard block list through unchanged', () => {
    expect(cloneOverrideValue({ toolBudget: { hard: 5, block: '*' } }).toolBudget).toEqual({ hard: 5, block: '*' });
  });
});

// ============================================================================
// Applying overrides to builtins
// ============================================================================

describe('applyBuiltinOverride', () => {
  const meta = { scope: 'project', path: '/repo/.pi/settings.json' } as const;

  it('replaces values outright and snapshots what it replaced', () => {
    const agent = makeAgent({ model: 'opus', thinking: 'high', skills: ['review'] });
    const next = applyBuiltinOverride(agent, { model: 'haiku' }, meta);

    expect(next.model).toBe('haiku');
    expect(next.override?.scope).toBe('project');
    expect(next.override?.path).toBe('/repo/.pi/settings.json');
    expect(next.override?.base).toEqual(cloneOverrideBase(agent));
    expect(next.override?.base.model).toBe('opus');
  });

  it('leaves absent keys alone, which is what makes false meaningful', () => {
    const agent = makeAgent({ model: 'opus', thinking: 'high', defaultContext: 'fork' });

    const untouched = applyBuiltinOverride(agent, { model: 'haiku' }, meta);
    expect(untouched.thinking).toBe('high');
    expect(untouched.defaultContext).toBe('fork');

    const cleared = applyBuiltinOverride(agent, { thinking: false, defaultContext: false, model: false }, meta);
    expect(cleared.thinking).toBeUndefined();
    expect(cleared.defaultContext).toBeUndefined();
    expect(cleared.model).toBeUndefined();
  });

  it('clears the array-valued fields on false', () => {
    const agent = makeAgent({
      fallbackModels: ['haiku'],
      skills: ['review'],
      extensions: ['ext-a'],
      subagentOnlyExtensions: ['ext-b'],
      toolBudget: { hard: 5 },
    });

    const cleared = applyBuiltinOverride(
      agent,
      { fallbackModels: false, skills: false, extensions: false, subagentOnlyExtensions: false, toolBudget: false },
      meta,
    );

    expect(cleared.fallbackModels).toBeUndefined();
    expect(cleared.skills).toBeUndefined();
    expect(cleared.extensions).toBeUndefined();
    expect(cleared.subagentOnlyExtensions).toBeUndefined();
    expect(cleared.toolBudget).toBeUndefined();
  });

  it('splits an overriding tool list on the mcp prefix', () => {
    const next = applyBuiltinOverride(makeAgent(), { tools: ['Read', 'mcp:pencil__browser', 'Write'] }, meta);

    expect(next.tools).toEqual(['Read', 'Write']);
    expect(next.mcpDirectTools).toEqual(['pencil__browser']);
  });

  it('turns a cleared tool list into an empty allowlist, not an absent one', () => {
    // `tools: false` means the agent may call nothing, which is `[]`. An absent
    // list would instead mean "inherit whatever the host allows".
    const next = applyBuiltinOverride(makeAgent({ tools: ['Read'], mcpDirectTools: ['x__y'] }), { tools: false }, meta);

    expect(next.tools).toEqual([]);
    expect(next.mcpDirectTools).toBeUndefined();
  });

  it('replaces the list-valued and enum fields with real values', () => {
    const next = applyBuiltinOverride(
      makeAgent({ defaultContext: 'fresh', toolBudget: { hard: 1 } }),
      {
        fallbackModels: ['haiku'],
        skills: ['audit'],
        extensions: ['ext-c'],
        subagentOnlyExtensions: ['ext-d'],
        defaultContext: 'fork',
        toolBudget: { hard: 9, block: '*' },
        thinking: 'high',
      },
      meta,
    );

    expect(next.fallbackModels).toEqual(['haiku']);
    expect(next.skills).toEqual(['audit']);
    expect(next.extensions).toEqual(['ext-c']);
    expect(next.subagentOnlyExtensions).toEqual(['ext-d']);
    expect(next.defaultContext).toBe('fork');
    expect(next.toolBudget).toEqual({ hard: 9, block: '*' });
    expect(next.thinking).toBe('high');
  });

  it('applies the boolean fields, including disabling the agent', () => {
    const next = applyBuiltinOverride(
      makeAgent(),
      {
        disabled: true,
        completionGuard: false,
        inheritProjectContext: false,
        inheritSkills: false,
        systemPromptMode: 'replace',
        systemPrompt: 'replaced',
      },
      meta,
    );

    expect(next.disabled).toBe(true);
    expect(next.completionGuard).toBe(false);
    expect(next.inheritProjectContext).toBe(false);
    expect(next.inheritSkills).toBe(false);
    expect(next.systemPromptMode).toBe('replace');
    expect(next.systemPrompt).toBe('replaced');
  });

  it('never mutates the agent it was handed', () => {
    const agent = makeAgent({ model: 'opus', tools: ['Read'], skills: ['review'] });
    const before = JSON.stringify(agent);

    applyBuiltinOverride(agent, { model: 'haiku', tools: false, skills: ['other'] }, meta);

    expect(JSON.stringify(agent)).toBe(before);
  });

  it('copies the arrays out of the override, so editing the settings object cannot reach the agent', () => {
    const override: BuiltinAgentOverrideConfig = { skills: ['review'], extensions: ['ext-a'] };
    const next = applyBuiltinOverride(makeAgent(), override, meta);

    if (Array.isArray(override.skills)) override.skills.push('other');

    expect(next.skills).toEqual(['review']);
  });
});

describe('clearBuiltinThinking', () => {
  const meta = { scope: 'user', path: '/home/settings.json' } as const;

  it('leaves an agent with no thinking level untouched', () => {
    const agent = makeAgent();
    expect(clearBuiltinThinking(agent, meta)).toBe(agent);
  });

  it('records why the agent differs from its builtin definition', () => {
    const agent = makeAgent({ thinking: 'high' });
    const next = clearBuiltinThinking(agent, meta);

    expect(next.thinking).toBeUndefined();
    expect(next.override?.scope).toBe('user');
    expect(next.override?.base.thinking).toBe('high');
    expect(agent.thinking).toBe('high');
  });

  it('keeps an existing override rather than replacing it with the bulk switch', () => {
    // The per-agent override is the more specific reason the agent differs, and
    // it is what a later "remove the override" has to restore from.
    const overridden = applyBuiltinOverride(makeAgent({ thinking: 'high', model: 'opus' }), { model: 'haiku' }, meta);
    const next = clearBuiltinThinking(overridden, { scope: 'project', path: '/repo/settings.json' });

    expect(next.override).toBe(overridden.override);
    expect(next.override?.base.model).toBe('opus');
  });
});

describe('applyBuiltinOverrides', () => {
  const projectSettingsPath = '/repo/.pi/settings.json';

  it('lets a project override beat a user override', () => {
    const agents = [makeAgent({ model: 'builtin-model' })];
    const next = only(
      applyBuiltinOverrides(
        agents,
        makeSettings({ overrides: { reviewer: { model: 'user-model' } } }),
        makeSettings({ overrides: { reviewer: { model: 'project-model' } } }),
        userSettingsPath,
        projectSettingsPath,
      ),
    );

    expect(next.model).toBe('project-model');
    expect(next.override?.scope).toBe('project');
  });

  it('lets an explicit per-agent override beat the bulk disable switch', () => {
    const next = only(
      applyBuiltinOverrides(
        [makeAgent()],
        EMPTY_SUBAGENT_SETTINGS,
        makeSettings({ overrides: { reviewer: { model: 'project-model' } }, disableBuiltins: true }),
        userSettingsPath,
        projectSettingsPath,
      ),
    );

    expect(next.model).toBe('project-model');
    expect(next.disabled).toBeUndefined();
  });

  it('disables every builtin the bulk switch covers', () => {
    const next = only(
      applyBuiltinOverrides(
        [makeAgent()],
        EMPTY_SUBAGENT_SETTINGS,
        makeSettings({ disableBuiltins: true }),
        userSettingsPath,
        projectSettingsPath,
      ),
    );

    expect(next.disabled).toBe(true);
    expect(next.override?.scope).toBe('project');
  });

  it('ignores project settings entirely when there is no project file', () => {
    const agents = [makeAgent()];
    const next = only(
      applyBuiltinOverrides(
        agents,
        EMPTY_SUBAGENT_SETTINGS,
        makeSettings({ overrides: { reviewer: { model: 'project-model' } }, disableBuiltins: true }),
        userSettingsPath,
        null,
      ),
    );

    expect(next).toBe(only(agents));
  });

  it('lets a project re-enable builtins its user settings turned off', () => {
    // Setting the key at all, even to false, shadows the user's switch.
    const agents = [makeAgent()];
    const next = only(
      applyBuiltinOverrides(
        agents,
        makeSettings({ disableBuiltins: true }),
        makeSettings({ disableBuiltins: false }),
        userSettingsPath,
        projectSettingsPath,
      ),
    );

    expect(next).toBe(only(agents));
  });

  it('falls through to the user bulk switch when the project says nothing', () => {
    const next = only(
      applyBuiltinOverrides(
        [makeAgent()],
        makeSettings({ disableBuiltins: true }),
        EMPTY_SUBAGENT_SETTINGS,
        userSettingsPath,
        projectSettingsPath,
      ),
    );

    expect(next.disabled).toBe(true);
    expect(next.override?.scope).toBe('user');
  });

  it('applies a user override when there is no project override', () => {
    const next = only(
      applyBuiltinOverrides(
        [makeAgent()],
        makeSettings({ overrides: { reviewer: { model: 'user-model' } } }),
        EMPTY_SUBAGENT_SETTINGS,
        userSettingsPath,
        projectSettingsPath,
      ),
    );

    expect(next.model).toBe('user-model');
    expect(next.override?.path).toBe(userSettingsPath);
  });

  it('strips thinking from every builtin when the bulk switch is on', () => {
    const next = only(
      applyBuiltinOverrides(
        [makeAgent({ thinking: 'high' })],
        makeSettings({ disableThinking: true }),
        EMPTY_SUBAGENT_SETTINGS,
        userSettingsPath,
        null,
      ),
    );

    expect(next.thinking).toBeUndefined();
    expect(next.override?.base.thinking).toBe('high');
  });

  it('keeps a per-agent thinking override alive through the bulk switch', () => {
    const next = only(
      applyBuiltinOverrides(
        [makeAgent({ thinking: 'high' })],
        makeSettings({ disableThinking: true, overrides: { reviewer: { thinking: 'low' } } }),
        EMPTY_SUBAGENT_SETTINGS,
        userSettingsPath,
        null,
      ),
    );

    expect(next.thinking).toBe('low');
  });

  it('lets a project disableThinking:false shadow the user switch', () => {
    const next = only(
      applyBuiltinOverrides(
        [makeAgent({ thinking: 'high' })],
        makeSettings({ disableThinking: true }),
        makeSettings({ disableThinking: false }),
        userSettingsPath,
        projectSettingsPath,
      ),
    );

    expect(next.thinking).toBe('high');
  });

  it('lets a project thinking switch outrank a user per-agent thinking override', () => {
    // Project beats user at the same specificity level, so the user's per-agent
    // exemption does not survive a project-wide switch.
    const next = only(
      applyBuiltinOverrides(
        [makeAgent({ thinking: 'high' })],
        makeSettings({ overrides: { reviewer: { thinking: 'low' } } }),
        makeSettings({ disableThinking: true }),
        userSettingsPath,
        projectSettingsPath,
      ),
    );

    expect(next.thinking).toBeUndefined();
  });

  it('never mutates the agents or the settings it was handed', () => {
    const agents = [makeAgent({ model: 'builtin', thinking: 'high', tools: ['Read'] })];
    const userSettings = makeSettings({ overrides: { reviewer: { model: 'user-model' } }, disableThinking: true });
    const projectSettings = makeSettings({ overrides: { reviewer: { skills: ['review'] } } });
    const agentsBefore = JSON.stringify(agents);
    const userBefore = JSON.stringify(userSettings);
    const projectBefore = JSON.stringify(projectSettings);

    applyBuiltinOverrides(agents, userSettings, projectSettings, userSettingsPath, projectSettingsPath);

    expect(JSON.stringify(agents)).toBe(agentsBefore);
    expect(JSON.stringify(userSettings)).toBe(userBefore);
    expect(JSON.stringify(projectSettings)).toBe(projectBefore);
  });
});

// ============================================================================
// Applying overrides to custom agents
// ============================================================================

describe('applyCustomAgentOverride', () => {
  const meta = { scope: 'project', path: '/repo/.pi/settings.json' } as const;

  it('never contradicts a field the author declared in frontmatter', () => {
    const agent = makeAgent({ source: 'project', model: 'own-model', thinking: 'high' });
    setAgentFrontmatterFields(agent, new Set(['model', 'thinking']));

    const next = applyCustomAgentOverride(agent, { model: 'settings-model', thinking: 'low' }, meta);

    // Nothing was filled, so no copy is made and the agent is not reported as
    // overridden in the UI.
    expect(next).toBe(agent);
  });

  it('fills a field the frontmatter left unset', () => {
    const agent = makeAgent({ source: 'project' });
    setAgentFrontmatterFields(agent, new Set(['description']));

    const next = applyCustomAgentOverride(agent, { model: 'settings-model' }, meta);

    expect(next.model).toBe('settings-model');
    expect(next.override).toEqual({ ...meta, base: cloneOverrideBase(agent) });
    expect(agent.model).toBeUndefined();
  });

  it('fills only the undeclared half of a mixed override', () => {
    const agent = makeAgent({ source: 'project', model: 'own-model' });
    setAgentFrontmatterFields(agent, new Set(['model']));

    const next = applyCustomAgentOverride(agent, { model: 'settings-model', thinking: 'low' }, meta);

    expect(next.model).toBe('own-model');
    expect(next.thinking).toBe('low');
  });

  it('accepts skills declared under either frontmatter spelling', () => {
    const agent = makeAgent({ source: 'project', skills: ['own'] });
    setAgentFrontmatterFields(agent, new Set(['skill']));

    expect(applyCustomAgentOverride(agent, { skills: ['settings'] }, meta)).toBe(agent);
  });

  it('splits a filled tool list on the mcp prefix', () => {
    const agent = makeAgent({ source: 'project' });
    const next = applyCustomAgentOverride(agent, { tools: ['Read', 'mcp:pencil__browser'] }, meta);

    expect(next.tools).toEqual(['Read']);
    expect(next.mcpDirectTools).toEqual(['pencil__browser']);
  });

  it('leaves a declared tool list alone', () => {
    const agent = makeAgent({ source: 'project', tools: ['Read'] });
    setAgentFrontmatterFields(agent, new Set(['tools']));

    expect(applyCustomAgentOverride(agent, { tools: ['Write'] }, meta)).toBe(agent);
  });

  it('fills disabled only when the agent has no value, regardless of frontmatter', () => {
    const undeclared = makeAgent({ source: 'project' });
    expect(applyCustomAgentOverride(undeclared, { disabled: true }, meta).disabled).toBe(true);

    const declared = makeAgent({ source: 'project', disabled: false });
    expect(applyCustomAgentOverride(declared, { disabled: true }, meta)).toBe(declared);
  });

  it('clears rather than fills when the override says false', () => {
    const agent = makeAgent({ source: 'project', model: 'own-model' });
    const next = applyCustomAgentOverride(agent, { model: false }, meta);

    expect(next.model).toBeUndefined();
    expect(next).not.toBe(agent);
  });

  it('fills the remaining supported fields', () => {
    const agent = makeAgent({ source: 'project' });
    const next = applyCustomAgentOverride(
      agent,
      {
        fallbackModels: ['haiku'],
        systemPromptMode: 'replace',
        inheritProjectContext: false,
        inheritSkills: false,
        defaultContext: 'fork',
        skills: ['review'],
        extensions: ['ext-a'],
        subagentOnlyExtensions: ['ext-b'],
        completionGuard: false,
        toolBudget: { hard: 5 },
      },
      meta,
    );

    expect(next.fallbackModels).toEqual(['haiku']);
    expect(next.systemPromptMode).toBe('replace');
    expect(next.inheritProjectContext).toBe(false);
    expect(next.inheritSkills).toBe(false);
    expect(next.defaultContext).toBe('fork');
    expect(next.skills).toEqual(['review']);
    expect(next.extensions).toEqual(['ext-a']);
    expect(next.subagentOnlyExtensions).toEqual(['ext-b']);
    expect(next.completionGuard).toBe(false);
    expect(next.toolBudget).toEqual({ hard: 5 });
  });

  it('clears the list-valued fields when the override says false', () => {
    const agent = makeAgent({
      source: 'project',
      fallbackModels: ['haiku'],
      skills: ['review'],
      tools: ['Read'],
      mcpDirectTools: ['pencil__browser'],
      extensions: ['ext-a'],
      subagentOnlyExtensions: ['ext-b'],
      toolBudget: { hard: 5 },
      defaultContext: 'fork',
      thinking: 'high',
    });

    const next = applyCustomAgentOverride(
      agent,
      {
        fallbackModels: false,
        skills: false,
        tools: false,
        extensions: false,
        subagentOnlyExtensions: false,
        toolBudget: false,
        defaultContext: false,
        thinking: false,
      },
      meta,
    );

    expect(next.fallbackModels).toBeUndefined();
    expect(next.skills).toBeUndefined();
    expect(next.tools).toEqual([]);
    expect(next.mcpDirectTools).toBeUndefined();
    expect(next.extensions).toBeUndefined();
    expect(next.subagentOnlyExtensions).toBeUndefined();
    expect(next.toolBudget).toBeUndefined();
    expect(next.defaultContext).toBeUndefined();
    expect(next.thinking).toBeUndefined();
  });

  it('carries the frontmatter record onto the copy', () => {
    const agent = makeAgent({ source: 'project', model: 'own-model' });
    setAgentFrontmatterFields(agent, new Set(['model']));

    const next = applyCustomAgentOverride(agent, { thinking: 'low' }, meta);

    expect(agentHasFrontmatterField(next, 'model')).toBe(true);
  });

  it('returns the agent untouched for an override that declared nothing', () => {
    const agent = makeAgent({ source: 'project' });
    expect(applyCustomAgentOverride(agent, {}, meta)).toBe(agent);
  });

  it('never mutates the agent it was handed', () => {
    const agent = makeAgent({ source: 'project' });
    const before = JSON.stringify(agent);

    applyCustomAgentOverride(agent, { model: 'settings-model', tools: ['Read'] }, meta);

    expect(JSON.stringify(agent)).toBe(before);
  });
});

describe('applyCustomAgentOverrides', () => {
  const projectSettingsPath = '/repo/.pi/settings.json';

  it('lets a project override beat a user override', () => {
    const next = only(
      applyCustomAgentOverrides(
        [makeAgent({ source: 'project' })],
        makeSettings({ overrides: { reviewer: { model: 'user-model' } } }),
        makeSettings({ overrides: { reviewer: { model: 'project-model' } } }),
        userSettingsPath,
        projectSettingsPath,
      ),
    );

    expect(next.model).toBe('project-model');
    expect(next.override?.scope).toBe('project');
  });

  it('falls back to the user override when there is no project file', () => {
    const next = only(
      applyCustomAgentOverrides(
        [makeAgent({ source: 'project' })],
        makeSettings({ overrides: { reviewer: { model: 'user-model' } } }),
        makeSettings({ overrides: { reviewer: { model: 'project-model' } } }),
        userSettingsPath,
        null,
      ),
    );

    expect(next.model).toBe('user-model');
  });

  it('leaves agents with no override alone', () => {
    const agents = [makeAgent({ name: 'other', source: 'project' })];
    const next = applyCustomAgentOverrides(
      agents,
      makeSettings({ overrides: { reviewer: { model: 'user-model' } } }),
      EMPTY_SUBAGENT_SETTINGS,
      userSettingsPath,
      projectSettingsPath,
    );

    expect(only(next)).toBe(only(agents));
  });

  it('never mutates the agents or settings it was handed', () => {
    const agents = [makeAgent({ source: 'project' })];
    const settings = makeSettings({ overrides: { reviewer: { skills: ['review'] } } });
    const agentsBefore = JSON.stringify(agents);
    const settingsBefore = JSON.stringify(settings);

    applyCustomAgentOverrides(agents, settings, EMPTY_SUBAGENT_SETTINGS, userSettingsPath, null);

    expect(JSON.stringify(agents)).toBe(agentsBefore);
    expect(JSON.stringify(settings)).toBe(settingsBefore);
  });
});

// ============================================================================
// Diffing an edited agent back into an override
// ============================================================================

describe('buildBuiltinOverrideConfig', () => {
  function snapshotOf(agent: AgentConfig): BuiltinOverrideSnapshot {
    return cloneOverrideBase(agent);
  }

  it('returns undefined when nothing changed, which callers read as "remove the override"', () => {
    const agent = makeAgent({ model: 'opus', tools: ['Read'], skills: ['review'], toolBudget: { hard: 5 } });
    expect(buildBuiltinOverrideConfig(snapshotOf(agent), agent)).toBeUndefined();
  });

  it('records only the fields that changed, so the file does not copy the builtin', () => {
    const agent = makeAgent({ model: 'opus', thinking: 'high' });
    const override = buildBuiltinOverrideConfig(snapshotOf(agent), { ...agent, model: 'haiku' });

    expect(override).toEqual({ model: 'haiku' });
  });

  it('writes false for a value the user cleared', () => {
    const agent = makeAgent({
      model: 'opus',
      thinking: 'high',
      defaultContext: 'fork',
      disabled: true,
      fallbackModels: ['haiku'],
      skills: ['review'],
      tools: ['Read'],
      extensions: ['ext-a'],
      subagentOnlyExtensions: ['ext-b'],
      toolBudget: { hard: 5 },
    });

    const override = buildBuiltinOverrideConfig(snapshotOf(agent), {
      model: undefined,
      thinking: undefined,
      defaultContext: undefined,
      disabled: undefined,
      fallbackModels: undefined,
      skills: undefined,
      tools: undefined,
      mcpDirectTools: undefined,
      extensions: undefined,
      subagentOnlyExtensions: undefined,
      toolBudget: undefined,
      systemPromptMode: agent.systemPromptMode,
      inheritProjectContext: agent.inheritProjectContext,
      inheritSkills: agent.inheritSkills,
      systemPrompt: agent.systemPrompt,
      completionGuard: agent.completionGuard,
    });

    expect(override).toEqual({
      model: false,
      thinking: false,
      defaultContext: false,
      disabled: false,
      fallbackModels: false,
      skills: false,
      tools: false,
      extensions: false,
      subagentOnlyExtensions: false,
      toolBudget: false,
    });
  });

  it('rejoins the split tool list, so an mcp tool survives the round trip', () => {
    const agent = makeAgent({ tools: ['Read'], mcpDirectTools: ['pencil__browser'] });
    const override = buildBuiltinOverrideConfig(snapshotOf(agent), {
      ...agent,
      mcpDirectTools: ['pencil__browser', 'other__tool'],
    });

    expect(override).toEqual({ tools: ['Read', 'mcp:pencil__browser', 'mcp:other__tool'] });
  });

  it('treats a reordered tool list as a real change', () => {
    const agent = makeAgent({ tools: ['Read', 'Write'] });
    expect(buildBuiltinOverrideConfig(snapshotOf(agent), { ...agent, tools: ['Write', 'Read'] })).toEqual({
      tools: ['Write', 'Read'],
    });
  });

  it('records only a real switch of the completion guard', () => {
    // An unset guard and an enabled one behave identically, so turning it "on"
    // when it was never set must not write an override.
    const unset = makeAgent();
    expect(buildBuiltinOverrideConfig(snapshotOf(unset), { ...unset, completionGuard: true })).toBeUndefined();
    expect(buildBuiltinOverrideConfig(snapshotOf(unset), { ...unset, completionGuard: false })).toEqual({
      completionGuard: false,
    });

    const disabled = makeAgent({ completionGuard: false });
    expect(buildBuiltinOverrideConfig(snapshotOf(disabled), { ...disabled, completionGuard: true })).toEqual({
      completionGuard: true,
    });
  });

  it('compares tool budgets by value, not by identity', () => {
    const agent = makeAgent({ toolBudget: { hard: 5, block: ['Bash'] } });

    expect(
      buildBuiltinOverrideConfig(snapshotOf(agent), { ...agent, toolBudget: { hard: 5, block: ['Bash'] } }),
    ).toBeUndefined();
    expect(buildBuiltinOverrideConfig(snapshotOf(agent), { ...agent, toolBudget: { hard: 9 } })).toEqual({
      toolBudget: { hard: 9 },
    });
  });

  it('records the plain fields that have no cleared form', () => {
    const agent = makeAgent();
    const override = buildBuiltinOverrideConfig(snapshotOf(agent), {
      ...agent,
      systemPromptMode: 'replace',
      inheritProjectContext: false,
      inheritSkills: false,
      systemPrompt: 'rewritten',
    });

    expect(override).toEqual({
      systemPromptMode: 'replace',
      inheritProjectContext: false,
      inheritSkills: false,
      systemPrompt: 'rewritten',
    });
  });

  it('records a replaced list rather than clearing it', () => {
    const agent = makeAgent({
      fallbackModels: ['haiku'],
      skills: ['review'],
      extensions: ['ext-a'],
      subagentOnlyExtensions: ['ext-b'],
    });

    const override = buildBuiltinOverrideConfig(snapshotOf(agent), {
      ...agent,
      fallbackModels: ['sonnet'],
      skills: ['audit'],
      extensions: ['ext-c'],
      subagentOnlyExtensions: ['ext-d'],
    });

    expect(override).toEqual({
      fallbackModels: ['sonnet'],
      skills: ['audit'],
      extensions: ['ext-c'],
      subagentOnlyExtensions: ['ext-d'],
    });
  });

  it('copies the arrays it records out of the draft', () => {
    const agent = makeAgent();
    const skills = ['review'];
    const override = buildBuiltinOverrideConfig(snapshotOf(agent), { ...agent, skills });

    skills.push('other');

    expect(override?.skills).toEqual(['review']);
  });
});

// ============================================================================
// Persisting overrides
// ============================================================================

describe('persisting overrides', () => {
  it('refuses a project write when the working directory sits under no project root', () => {
    const cwd = makeTempDir();

    expect(() => saveBuiltinAgentOverride(cwd, 'reviewer', 'project', { model: 'opus' })).toThrow(
      'No project config root was found.',
    );
    expect(() => mergeBuiltinAgentOverride(cwd, 'reviewer', 'project', { model: 'opus' })).toThrow(
      'No project config root was found.',
    );
    expect(() => removeBuiltinAgentOverride(cwd, 'reviewer', 'project')).toThrow('No project config root was found.');
    expect(() => removeBuiltinAgentOverrideFields(cwd, 'reviewer', 'project', ['model'])).toThrow(
      'No project config root was found.',
    );
  });

  it('creates the settings file on the first user-scope save', () => {
    const cwd = makeTempDir();

    const written = saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'opus' });

    expect(written).toBe(userSettingsPath);
    expect(readSettingsFileStrict(userSettingsPath)).toEqual({
      subagents: { agentOverrides: { reviewer: { model: 'opus' } } },
    });
  });

  it('replaces an existing entry wholesale rather than merging into it', () => {
    const cwd = makeTempDir();
    saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'opus', thinking: 'high' });
    saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'haiku' });

    expect(readSubagentSettings(userSettingsPath).overrides).toEqual({ reviewer: { model: 'haiku' } });
  });

  it('preserves unrelated settings around the override it writes', () => {
    const cwd = makeTempDir();
    writeJson(userSettingsPath, { theme: 'dark', subagents: { defaultModel: 'opus' } });

    saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'haiku' });

    expect(readSettingsFileStrict(userSettingsPath)).toEqual({
      theme: 'dark',
      subagents: { defaultModel: 'opus', agentOverrides: { reviewer: { model: 'haiku' } } },
    });
  });

  it('merges named fields into an existing entry, leaving the rest in place', () => {
    const cwd = makeTempDir();
    saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'opus', thinking: 'high' });

    mergeBuiltinAgentOverride(cwd, 'reviewer', 'user', { thinking: 'low', skills: ['review'] });

    expect(readSubagentSettings(userSettingsPath).overrides).toEqual({
      reviewer: { model: 'opus', thinking: 'low', skills: ['review'] },
    });
  });

  it('merges into a fresh entry when the agent had no override yet', () => {
    const cwd = makeTempDir();
    mergeBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'opus' });

    expect(readSubagentSettings(userSettingsPath).overrides).toEqual({ reviewer: { model: 'opus' } });
  });

  it('reports nothing removed when there is nothing to remove', () => {
    const cwd = makeTempDir();

    expect(removeBuiltinAgentOverride(cwd, 'reviewer', 'user')).toEqual({ path: userSettingsPath, removed: false });

    writeJson(userSettingsPath, { theme: 'dark' });
    expect(removeBuiltinAgentOverride(cwd, 'reviewer', 'user')).toEqual({ path: userSettingsPath, removed: false });

    writeJson(userSettingsPath, { subagents: { defaultModel: 'opus' } });
    expect(removeBuiltinAgentOverride(cwd, 'reviewer', 'user')).toEqual({ path: userSettingsPath, removed: false });

    writeJson(userSettingsPath, { subagents: { agentOverrides: { other: { model: 'opus' } } } });
    expect(removeBuiltinAgentOverride(cwd, 'reviewer', 'user')).toEqual({ path: userSettingsPath, removed: false });
  });

  it('keeps the other agents when removing one override', () => {
    const cwd = makeTempDir();
    saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'opus' });
    saveBuiltinAgentOverride(cwd, 'writer', 'user', { model: 'haiku' });

    expect(removeBuiltinAgentOverride(cwd, 'reviewer', 'user').removed).toBe(true);
    expect(readSubagentSettings(userSettingsPath).overrides).toEqual({ writer: { model: 'haiku' } });
  });

  it('leaves the file as it was before any override was added', () => {
    // An emptied container left behind would read back as configured-but-empty,
    // which is not the state the user asked for.
    const cwd = makeTempDir();
    writeJson(userSettingsPath, { theme: 'dark' });
    saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'opus' });

    removeBuiltinAgentOverride(cwd, 'reviewer', 'user');

    expect(readSettingsFileStrict(userSettingsPath)).toEqual({ theme: 'dark' });
  });

  it('keeps sibling subagent settings when the last override goes', () => {
    const cwd = makeTempDir();
    writeJson(userSettingsPath, { subagents: { defaultModel: 'opus', agentOverrides: { reviewer: { model: 'x' } } } });

    removeBuiltinAgentOverride(cwd, 'reviewer', 'user');

    expect(readSettingsFileStrict(userSettingsPath)).toEqual({ subagents: { defaultModel: 'opus' } });
  });

  it('removes named fields and reports when none of them were present', () => {
    const cwd = makeTempDir();
    saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'opus', thinking: 'high' });

    expect(removeBuiltinAgentOverrideFields(cwd, 'reviewer', 'user', ['skills'])).toEqual({
      path: userSettingsPath,
      removed: false,
    });
    expect(removeBuiltinAgentOverrideFields(cwd, 'reviewer', 'user', ['thinking', 'skills'])).toEqual({
      path: userSettingsPath,
      removed: true,
    });
    expect(readSubagentSettings(userSettingsPath).overrides).toEqual({ reviewer: { model: 'opus' } });
  });

  it('drops the whole entry once its last field is removed', () => {
    const cwd = makeTempDir();
    writeJson(userSettingsPath, { theme: 'dark' });
    saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'opus' });

    expect(removeBuiltinAgentOverrideFields(cwd, 'reviewer', 'user', ['model']).removed).toBe(true);
    expect(readSettingsFileStrict(userSettingsPath)).toEqual({ theme: 'dark' });
  });

  it('keeps the other agents when one entry is emptied field by field', () => {
    const cwd = makeTempDir();
    saveBuiltinAgentOverride(cwd, 'reviewer', 'user', { model: 'opus' });
    saveBuiltinAgentOverride(cwd, 'writer', 'user', { model: 'haiku' });

    expect(removeBuiltinAgentOverrideFields(cwd, 'reviewer', 'user', ['model']).removed).toBe(true);

    expect(readSubagentSettings(userSettingsPath).overrides).toEqual({ writer: { model: 'haiku' } });
  });

  it('reports nothing removed when the file, block, or entry is missing', () => {
    const cwd = makeTempDir();

    expect(removeBuiltinAgentOverrideFields(cwd, 'reviewer', 'user', ['model']).removed).toBe(false);

    writeJson(userSettingsPath, { theme: 'dark' });
    expect(removeBuiltinAgentOverrideFields(cwd, 'reviewer', 'user', ['model']).removed).toBe(false);

    writeJson(userSettingsPath, { subagents: { defaultModel: 'opus' } });
    expect(removeBuiltinAgentOverrideFields(cwd, 'reviewer', 'user', ['model']).removed).toBe(false);

    writeJson(userSettingsPath, { subagents: { agentOverrides: { other: { model: 'opus' } } } });
    expect(removeBuiltinAgentOverrideFields(cwd, 'reviewer', 'user', ['model']).removed).toBe(false);
  });

  it('writes project overrides into the project config directory', () => {
    const { cwd, settingsPath } = makeProjectRoot();

    expect(saveBuiltinAgentOverride(cwd, 'reviewer', 'project', { model: 'opus' })).toBe(settingsPath);
    expect(readSubagentSettings(settingsPath).overrides).toEqual({ reviewer: { model: 'opus' } });
  });
});

describe('override round trip', () => {
  it('restores the builtin exactly once its override is removed', () => {
    const { cwd, settingsPath } = makeProjectRoot();
    const builtin = makeAgent({
      model: 'opus',
      thinking: 'high',
      skills: ['review'],
      tools: ['Read'],
      mcpDirectTools: ['pencil__browser'],
      toolBudget: { hard: 5 },
    });
    const before = JSON.stringify(builtin);

    saveBuiltinAgentOverride(cwd, 'reviewer', 'project', { model: 'haiku', thinking: false, tools: false });
    const overridden = only(
      applyBuiltinOverrides(
        [builtin],
        EMPTY_SUBAGENT_SETTINGS,
        readSubagentSettings(settingsPath),
        userSettingsPath,
        settingsPath,
      ),
    );

    expect(overridden.model).toBe('haiku');
    expect(overridden.thinking).toBeUndefined();
    // The snapshot is what makes the removal below restorable at all.
    expect(overridden.override?.base.model).toBe('opus');
    expect(overridden.override?.base.tools).toEqual(['Read']);
    // The direct MCP tools are stored on the snapshot, but `AgentConfig.override.base`
    // is typed as the narrower `BuiltinAgentOverrideBase`, which does not declare the
    // field. Reading it needs the widened snapshot type. See the note in the report.
    const snapshot: BuiltinOverrideSnapshot = overridden.override?.base ?? {};
    expect(snapshot.mcpDirectTools).toEqual(['pencil__browser']);

    expect(removeBuiltinAgentOverride(cwd, 'reviewer', 'project')).toEqual({ path: settingsPath, removed: true });

    const restored = only(
      applyBuiltinOverrides(
        [builtin],
        EMPTY_SUBAGENT_SETTINGS,
        readSubagentSettings(settingsPath),
        userSettingsPath,
        settingsPath,
      ),
    );

    expect(JSON.stringify(restored)).toBe(before);
    expect(restored.override).toBeUndefined();
    expect(readSettingsFileStrict(settingsPath)).toEqual({});
  });

  it('rebuilds the same override from a snapshot and an edited draft', () => {
    const builtin = makeAgent({ model: 'opus', tools: ['Read'], mcpDirectTools: ['pencil__browser'] });
    const overridden = applyBuiltinOverride(
      builtin,
      { model: 'haiku', tools: ['Write', 'mcp:other__tool'] },
      { scope: 'user', path: userSettingsPath },
    );
    const base = overridden.override?.base;
    if (!base) throw new Error('expected an override snapshot');

    expect(buildBuiltinOverrideConfig(base, overridden)).toEqual({
      model: 'haiku',
      tools: ['Write', 'mcp:other__tool'],
    });
  });
});
