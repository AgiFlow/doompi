import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRuntimeName,
  defaultInheritProjectContext,
  defaultInheritSkills,
  defaultSystemPromptMode,
  EXTRA_AGENT_DIRS_ENV,
  listFilesRecursive,
  loadAgentsFromDir,
  parsePackageName,
  pluginAgentDirs,
  splitToolList,
} from '../../src/adapters/agents/loader';
import { parseFrontmatter, parseFrontmatterList } from '../../src/adapters/agents/frontmatter';
import type { AgentConfig } from '../../src/adapters/agents/types';
import { getProjectConfigDir } from '../../src/adapters/filesystem/configDir';

const temporaryDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-agents-'));
  temporaryDirs.push(dir);
  return dir;
}

/** Write an agent file at `relativePath` under `dir`, creating parent directories. */
function writeFile(dir: string, relativePath: string, content: string): string {
  const filePath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** A definition file with the given frontmatter lines and body. */
function agentFile(frontmatterLines: string[], body = 'System prompt.'): string {
  return `---\n${frontmatterLines.join('\n')}\n---\n${body}\n`;
}

/** Load one agent and fail loudly if the directory produced anything else. */
function loadSingleAgent(dir: string): AgentConfig {
  const agents = loadAgentsFromDir(dir, 'project');
  expect(agents).toHaveLength(1);
  const agent = agents[0];
  if (!agent) throw new Error('expected one agent');
  return agent;
}

const originalExtraAgentDirs = process.env[EXTRA_AGENT_DIRS_ENV];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  // Never let a test read the real user config directory.
  process.env.PI_CODING_AGENT_DIR = makeTempDir();
});

afterEach(() => {
  if (originalExtraAgentDirs === undefined) delete process.env[EXTRA_AGENT_DIRS_ENV];
  else process.env[EXTRA_AGENT_DIRS_ENV] = originalExtraAgentDirs;

  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// frontmatter
// ============================================================================

describe('parseFrontmatter block detection', () => {
  it('treats a file with no opening fence as all body', () => {
    const content = 'Just a document.\n\nname: not-frontmatter\n';
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(content);
  });

  it('treats an unterminated block as all body, so a truncated file is skipped rather than half-read', () => {
    const content = '---\nname: reviewer\ndescription: never closed\n';
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(content);
  });

  it('accepts an empty block', () => {
    const parsed = parseFrontmatter('---\n---\nBody text.\n');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('Body text.');
  });

  it('normalizes CRLF, so a file authored on Windows parses identically', () => {
    const parsed = parseFrontmatter('---\r\nname: winner\r\ndescription: ok\r\n---\r\nLine one\r\nLine two\r\n');
    expect(parsed.frontmatter).toEqual({ name: 'winner', description: 'ok' });
    expect(parsed.body).toBe('Line one\nLine two');
  });

  it('keeps a colon inside a value, which a naive split on ":" would truncate', () => {
    const parsed = parseFrontmatter('---\ndescription: Reviews code: carefully, and slowly\n---\nBody\n');
    expect(parsed.frontmatter.description).toBe('Reviews code: carefully, and slowly');
  });

  it('strips matching surrounding quotes but leaves inner quotes alone', () => {
    const parsed = parseFrontmatter(
      ['---', 'a: "quoted: value"', "b: 'single quoted'", "c: it's unquoted", 'd: "mismatched\'', '---', 'Body'].join(
        '\n',
      ),
    );
    expect(parsed.frontmatter.a).toBe('quoted: value');
    expect(parsed.frontmatter.b).toBe('single quoted');
    expect(parsed.frontmatter.c).toBe("it's unquoted");
    expect(parsed.frontmatter.d).toBe('"mismatched\'');
  });

  it('does not treat a --- line inside the body as a delimiter', () => {
    const content = ['---', 'name: writer', 'description: writes', '---', 'Intro', '', '---', '', 'More body'].join(
      '\n',
    );
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter).toEqual({ name: 'writer', description: 'writes' });
    expect(parsed.body).toBe('Intro\n\n---\n\nMore body');
  });

  it('ignores comment and blank lines inside the block', () => {
    const parsed = parseFrontmatter(['---', '# a comment', '', 'name: commented', '---', 'Body'].join('\n'));
    expect(parsed.frontmatter).toEqual({ name: 'commented' });
  });
});

describe('parseFrontmatter block values', () => {
  it('captures an indented block as one dedented string, so a serializer can re-indent it', () => {
    const parsed = parseFrontmatter(
      ['---', 'memory:', '  scope: user', '  limits:', '    - one', 'name: x', '---', 'Body'].join('\n'),
    );
    expect(parsed.frontmatter.memory).toBe('scope: user\nlimits:\n  - one');
    expect(parsed.frontmatter.name).toBe('x');
  });

  it('folds a > block onto one line, keeping more-indented lines as real breaks', () => {
    const parsed = parseFrontmatter(
      ['---', 'description: >', '  first line', '  second line', '', '  after blank', '---', 'Body'].join('\n'),
    );
    expect(parsed.frontmatter.description).toBe('first line second line\nafter blank');
  });

  it('folds a >- block the same way, since the chomp indicator changes nothing here', () => {
    const parsed = parseFrontmatter(['---', 'note: >-', '  alpha', '  beta', '---', 'Body'].join('\n'));
    expect(parsed.frontmatter.note).toBe('alpha beta');
  });

  it('keeps a more-indented folded line on its own line, because reflowing it would corrupt a prompt', () => {
    const parsed = parseFrontmatter(['---', 'note: >', '  alpha', '    indented', '  beta', '---', 'Body'].join('\n'));
    expect(parsed.frontmatter.note).toBe('alpha\n  indented\nbeta');
  });

  it('drops blank lines that lead a folded block, which carry no paragraph break', () => {
    const parsed = parseFrontmatter(['---', 'note: >', '', '', '  alpha', '---', 'Body'].join('\n'));
    expect(parsed.frontmatter.note).toBe('alpha');
  });

  it('adds a break for a blank line next to a more-indented folded line', () => {
    const parsed = parseFrontmatter(
      ['---', 'note: >', '  alpha', '    indented', '', '  beta', '---', 'Body'].join('\n'),
    );
    expect(parsed.frontmatter.note).toBe('alpha\n  indented\n\nbeta');
  });

  it('yields an empty string for a key whose block never arrives', () => {
    const parsed = parseFrontmatter(['---', 'tools:', 'name: x', '---', 'Body'].join('\n'));
    expect(parsed.frontmatter.tools).toBe('');
  });

  it('flushes a trailing block at the end of the frontmatter', () => {
    const parsed = parseFrontmatter(['---', 'name: x', 'prompt:', '  trailing block', '---', 'Body'].join('\n'));
    expect(parsed.frontmatter.prompt).toBe('trailing block');
  });
});

describe('parseFrontmatterList', () => {
  it('returns undefined for an absent key, which is not the same as an empty list', () => {
    expect(parseFrontmatterList(undefined)).toBeUndefined();
  });

  it('reads a comma-separated value', () => {
    expect(parseFrontmatterList('read, write ,bash')).toEqual(['read', 'write', 'bash']);
  });

  it('reads a block list', () => {
    expect(parseFrontmatterList('- read\n- write')).toEqual(['read', 'write']);
  });

  it('keeps a hyphen inside a name, so context-builder is not read as a bullet', () => {
    expect(parseFrontmatterList('- context-builder\nplain-name')).toEqual(['context-builder', 'plain-name']);
  });

  it('drops empty entries left by trailing separators', () => {
    expect(parseFrontmatterList('read,,\n\n')).toEqual(['read']);
  });
});

// ============================================================================
// Identity and tool helpers
// ============================================================================

describe('package names and runtime names', () => {
  it('treats absent, empty, and false as "no package" rather than an error', () => {
    expect(parsePackageName(undefined)).toEqual({ packageName: undefined });
    expect(parsePackageName('')).toEqual({ packageName: undefined });
    expect(parsePackageName(false)).toEqual({ packageName: undefined });
  });

  it('rejects a non-string value', () => {
    expect(parsePackageName(42).error).toContain('must be a string');
  });

  it('sanitizes a human-written name instead of rejecting it', () => {
    expect(parsePackageName('  My Tools  ')).toEqual({ packageName: 'my-tools' });
    expect(parsePackageName('Ops..Tools--X')).toEqual({ packageName: 'ops.tools-x' });
  });

  it('rejects a value that sanitizes down to nothing addressable', () => {
    expect(parsePackageName('***', 'custom label').error).toBe('custom label is invalid after sanitization.');
    expect(parsePackageName('...').error).toContain('invalid after sanitization');
  });

  it('qualifies a name only when there is a package', () => {
    expect(buildRuntimeName('worker')).toBe('worker');
    expect(buildRuntimeName('worker', '  ')).toBe('worker');
    expect(buildRuntimeName('worker', 'ops')).toBe('ops.worker');
  });
});

describe('splitToolList', () => {
  it('returns neither list for an absent value, so "unset" stays distinct from "none"', () => {
    expect(splitToolList(undefined)).toEqual({});
  });

  it('keeps an empty list, which means the agent gets no tools', () => {
    expect(splitToolList([])).toEqual({ tools: [] });
  });

  it('routes mcp: entries to the field the MCP layer enforces', () => {
    expect(splitToolList(['read', 'mcp:server_tool', 'bash'])).toEqual({
      tools: ['read', 'bash'],
      mcpDirectTools: ['server_tool'],
    });
  });
});

describe('builtin defaults', () => {
  it('gives delegate the host context and every other agent a clean one', () => {
    expect(defaultSystemPromptMode('delegate')).toBe('append');
    expect(defaultSystemPromptMode('reviewer')).toBe('replace');
    expect(defaultInheritProjectContext('delegate')).toBe(true);
    expect(defaultInheritProjectContext('reviewer')).toBe(false);
    expect(defaultInheritSkills()).toBe(false);
  });
});

// ============================================================================
// Directory walk
// ============================================================================

describe('listFilesRecursive', () => {
  const isMarkdown = (fileName: string): boolean => fileName.endsWith('.md');

  it('returns nothing for a directory that does not exist', () => {
    expect(listFilesRecursive(path.join(makeTempDir(), 'absent'), isMarkdown)).toEqual([]);
  });

  it('walks nested directories and returns a stable, sorted order', () => {
    const dir = makeTempDir();
    writeFile(dir, 'b.md', 'b');
    writeFile(dir, 'a.md', 'a');
    writeFile(dir, 'nested/deep/c.md', 'c');
    writeFile(dir, 'skip.txt', 'x');

    expect(listFilesRecursive(dir, isMarkdown)).toEqual([
      path.join(dir, 'a.md'),
      path.join(dir, 'b.md'),
      path.join(dir, 'nested', 'deep', 'c.md'),
    ]);
  });

  it('prunes .git and node_modules', () => {
    const dir = makeTempDir();
    writeFile(dir, 'keep.md', 'keep');
    writeFile(dir, '.git/hooks/hook.md', 'no');
    writeFile(dir, 'node_modules/pkg/readme.md', 'no');

    expect(listFilesRecursive(dir, isMarkdown)).toEqual([path.join(dir, 'keep.md')]);
  });

  it('prunes a nested repository, so a checked-out sub-repo cannot contribute files', () => {
    const dir = makeTempDir();
    writeFile(dir, 'keep.md', 'keep');
    fs.mkdirSync(path.join(dir, 'vendor', '.git'), { recursive: true });
    writeFile(dir, 'vendor/other.md', 'no');

    expect(listFilesRecursive(dir, isMarkdown)).toEqual([path.join(dir, 'keep.md')]);
  });

  it('follows a symlinked file, because staging an agent by symlink is supported', () => {
    const source = makeTempDir();
    const target = writeFile(source, 'shared.md', 'shared');
    const dir = makeTempDir();
    fs.symlinkSync(target, path.join(dir, 'linked.md'));

    expect(listFilesRecursive(dir, isMarkdown)).toEqual([path.join(dir, 'linked.md')]);
  });
});

// ============================================================================
// loadAgentsFromDir
// ============================================================================

describe('loadAgentsFromDir minimal agent', () => {
  it('reads name, description, and body, and defaults everything else', () => {
    const dir = makeTempDir();
    const filePath = writeFile(
      dir,
      'reviewer.md',
      agentFile(['name: reviewer', 'description: Reviews diffs'], 'You review code.'),
    );

    const agent = loadSingleAgent(dir);

    expect(agent.name).toBe('reviewer');
    expect(agent.localName).toBe('reviewer');
    expect(agent.packageName).toBeUndefined();
    expect(agent.description).toBe('Reviews diffs');
    expect(agent.systemPrompt).toBe('You review code.');
    expect(agent.filePath).toBe(filePath);
    expect(agent.systemPromptMode).toBe('replace');
    expect(agent.inheritProjectContext).toBe(false);
    expect(agent.inheritSkills).toBe(false);
    expect(agent.defaultProgress).toBe(false);
    expect(agent.interactive).toBe(false);
    expect(agent.tools).toBeUndefined();
    expect(agent.mcpDirectTools).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.fallbackModels).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.defaultContext).toBeUndefined();
    expect(agent.defaultTimeoutMs).toBeUndefined();
    expect(agent.skills).toBeUndefined();
    expect(agent.skillPath).toBeUndefined();
    expect(agent.extensions).toBeUndefined();
    expect(agent.subagentOnlyExtensions).toBeUndefined();
    expect(agent.output).toBeUndefined();
    expect(agent.defaultReads).toBeUndefined();
    expect(agent.maxSubagentDepth).toBeUndefined();
    expect(agent.completionGuard).toBeUndefined();
    expect(agent.toolBudget).toBeUndefined();
    expect(agent.memory).toBeUndefined();
    expect(agent.extraFields).toBeUndefined();
  });

  it('applies the delegate defaults by name, since that builtin extends the host context', () => {
    const dir = makeTempDir();
    writeFile(dir, 'delegate.md', agentFile(['name: delegate', 'description: Works on my behalf']));

    const agent = loadSingleAgent(dir);
    expect(agent.systemPromptMode).toBe('append');
    expect(agent.inheritProjectContext).toBe(true);
  });

  it('records the source it was asked for, which is what drives shadowing later', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.md', agentFile(['name: a', 'description: d']));

    expect(loadAgentsFromDir(dir, 'plugin')[0]?.source).toBe('plugin');
    expect(loadAgentsFromDir(dir, 'user')[0]?.source).toBe('user');
    expect(loadAgentsFromDir(dir, 'project')[0]?.source).toBe('project');
  });
});

describe('loadAgentsFromDir field interpretation', () => {
  it('interprets every field the loader owns', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'full.md',
      agentFile(
        [
          'name: full',
          'package: My Tools',
          'description: Everything set',
          'tools: read, mcp:server_tool, bash',
          'model: sonnet',
          'fallbackModels: haiku, opus',
          'thinking: high',
          'systemPromptMode: append',
          'inheritProjectContext: true',
          'inheritSkills: true',
          'defaultContext: fork',
          'timeoutMs: 90000',
          'skills: alpha, beta',
          'skillPath: /skills/a, /skills/b',
          'extensions: ext-a',
          'subagentOnlyExtensions: ext-b',
          'output: json',
          'defaultReads: README.md',
          'defaultProgress: true',
          'interactive: true',
          'maxSubagentDepth: 3',
          'completionGuard: false',
          'toolBudget: {"maxCalls": 12}',
          'memory: { scope: user, enabled: true, maxEntries: 5 }',
        ],
        'Prompt body.',
      ),
    );

    const agent = loadSingleAgent(dir);

    expect(agent.name).toBe('my-tools.full');
    expect(agent.localName).toBe('full');
    expect(agent.packageName).toBe('my-tools');
    expect(agent.tools).toEqual(['read', 'bash']);
    expect(agent.mcpDirectTools).toEqual(['server_tool']);
    expect(agent.model).toBe('sonnet');
    expect(agent.fallbackModels).toEqual(['haiku', 'opus']);
    expect(agent.thinking).toBe('high');
    expect(agent.systemPromptMode).toBe('append');
    expect(agent.inheritProjectContext).toBe(true);
    expect(agent.inheritSkills).toBe(true);
    expect(agent.defaultContext).toBe('fork');
    expect(agent.defaultTimeoutMs).toBe(90000);
    expect(agent.skills).toEqual(['alpha', 'beta']);
    expect(agent.skillPath).toEqual(['/skills/a', '/skills/b']);
    expect(agent.extensions).toEqual(['ext-a']);
    expect(agent.subagentOnlyExtensions).toEqual(['ext-b']);
    expect(agent.output).toBe('json');
    expect(agent.defaultReads).toEqual(['README.md']);
    expect(agent.defaultProgress).toBe(true);
    expect(agent.interactive).toBe(true);
    expect(agent.maxSubagentDepth).toBe(3);
    expect(agent.completionGuard).toBe(false);
    expect(agent.toolBudget).toEqual({ maxCalls: 12 });
    expect(agent.memory).toEqual({ enabled: true, scope: 'user', maxEntries: 5 });
    expect(agent.extraFields).toBeUndefined();
  });

  it('reads skills from the singular spelling too', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.md', agentFile(['name: a', 'description: d', 'skill: solo']));
    expect(loadSingleAgent(dir).skills).toEqual(['solo']);
  });

  it('keeps an empty tools list, because "no tools" is not "tools unset"', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.md', agentFile(['name: a', 'description: d', 'tools:']));
    expect(loadSingleAgent(dir).tools).toEqual([]);
  });

  it('reads thinking: false as a disable rather than as the string', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.md', agentFile(['name: a', 'description: d', 'thinking: false']));
    expect(loadSingleAgent(dir).thinking).toBe(false);
  });

  it('honours explicit false for the tri-state booleans', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'delegate.md',
      agentFile([
        'name: delegate',
        'description: d',
        'inheritProjectContext: false',
        'inheritSkills: false',
        'completionGuard: true',
      ]),
    );

    const agent = loadSingleAgent(dir);
    // delegate defaults to true, so this pins that the author's value wins.
    expect(agent.inheritProjectContext).toBe(false);
    expect(agent.inheritSkills).toBe(false);
    expect(agent.completionGuard).toBe(true);
  });

  it('falls back to the default when a boolean is neither true nor false', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'a.md',
      agentFile(['name: a', 'description: d', 'inheritProjectContext: yes', 'completionGuard: maybe']),
    );

    const agent = loadSingleAgent(dir);
    expect(agent.inheritProjectContext).toBe(false);
    expect(agent.completionGuard).toBeUndefined();
  });

  it('keeps a zero depth but drops a negative or non-integer one', () => {
    const dir = makeTempDir();
    writeFile(dir, 'zero.md', agentFile(['name: zero', 'description: d', 'maxSubagentDepth: 0']));
    writeFile(dir, 'neg.md', agentFile(['name: neg', 'description: d', 'maxSubagentDepth: -1']));
    writeFile(dir, 'word.md', agentFile(['name: word', 'description: d', 'maxSubagentDepth: deep']));

    const byName = new Map(loadAgentsFromDir(dir, 'project').map((agent) => [agent.name, agent]));
    expect(byName.get('zero')?.maxSubagentDepth).toBe(0);
    expect(byName.get('neg')?.maxSubagentDepth).toBeUndefined();
    expect(byName.get('word')?.maxSubagentDepth).toBeUndefined();
  });

  it('ignores an unknown systemPromptMode or defaultContext instead of failing the file', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'a.md',
      agentFile(['name: a', 'description: d', 'systemPromptMode: merge', 'defaultContext: sideways']),
    );

    const agent = loadSingleAgent(dir);
    expect(agent.systemPromptMode).toBe('replace');
    expect(agent.defaultContext).toBeUndefined();
  });
});

describe('loadAgentsFromDir async-only behaviour', () => {
  it('does not interpret async, because this package has no synchronous run mode', () => {
    const dir = makeTempDir();
    writeFile(dir, 'legacy.md', agentFile(['name: legacy', 'description: d', 'async: true']));

    const agent = loadSingleAgent(dir);

    // The predecessor produced a `defaultAsync` here. Pinning its absence is
    // what stops the field quietly coming back with the old semantics.
    expect('defaultAsync' in agent).toBe(false);
    // It still round-trips, so a file written for the predecessor is not damaged.
    expect(agent.extraFields).toEqual({ async: 'true' });
  });
});

describe('loadAgentsFromDir extraFields', () => {
  it('preserves uninterpreted keys verbatim so a writer can round-trip the file', () => {
    const dir = makeTempDir();
    writeFile(
      dir,
      'a.md',
      agentFile(['name: a', 'description: d', 'model: sonnet', 'color: blue', 'custom-key: 42', 'async: false']),
    );

    const agent = loadSingleAgent(dir);
    expect(agent.extraFields).toEqual({ color: 'blue', 'custom-key': '42', async: 'false' });
    // Known keys must not be duplicated into extraFields, or they get written twice.
    expect(agent.extraFields?.model).toBeUndefined();
    expect(agent.extraFields?.name).toBeUndefined();
  });
});

describe('loadAgentsFromDir file selection', () => {
  it('skips chain files and non-markdown files', () => {
    const dir = makeTempDir();
    writeFile(dir, 'agent.md', agentFile(['name: agent', 'description: d']));
    writeFile(dir, 'flow.chain.md', agentFile(['name: flow', 'description: d']));
    writeFile(dir, 'notes.txt', agentFile(['name: notes', 'description: d']));

    expect(loadAgentsFromDir(dir, 'project').map((agent) => agent.name)).toEqual(['agent']);
  });

  it('walks nested directories', () => {
    const dir = makeTempDir();
    writeFile(dir, 'top.md', agentFile(['name: top', 'description: d']));
    writeFile(dir, 'team/deep/nested.md', agentFile(['name: nested', 'description: d']));

    expect(loadAgentsFromDir(dir, 'project').map((agent) => agent.name)).toEqual(['nested', 'top']);
  });

  it('does not absorb agents from a nested project root', () => {
    const dir = makeTempDir();
    writeFile(dir, 'mine.md', agentFile(['name: mine', 'description: d']));
    // A sub-directory that owns its own config directory is a separate project.
    fs.mkdirSync(getProjectConfigDir(path.join(dir, 'sub')), { recursive: true });
    writeFile(dir, 'sub/theirs.md', agentFile(['name: theirs', 'description: d']));

    expect(loadAgentsFromDir(dir, 'project').map((agent) => agent.name)).toEqual(['mine']);
  });

  it('does not absorb agents from a nested legacy .agents project root', () => {
    const dir = makeTempDir();
    writeFile(dir, 'mine.md', agentFile(['name: mine', 'description: d']));
    fs.mkdirSync(path.join(dir, 'sub', '.agents'), { recursive: true });
    writeFile(dir, 'sub/theirs.md', agentFile(['name: theirs', 'description: d']));

    expect(loadAgentsFromDir(dir, 'project').map((agent) => agent.name)).toEqual(['mine']);
  });

  it('scans the root itself even when the root is the project config dir', () => {
    const dir = makeTempDir();
    const configDir = getProjectConfigDir(dir);
    fs.mkdirSync(configDir, { recursive: true });
    writeFile(configDir, 'agent/own.md', agentFile(['name: own', 'description: d']));

    expect(loadAgentsFromDir(configDir, 'project').map((agent) => agent.name)).toEqual(['own']);
  });

  it('skips legacy .agents/skills documents, which are skills and not agents', () => {
    const dir = makeTempDir();
    writeFile(dir, '.agents/real.md', agentFile(['name: real', 'description: d']));
    writeFile(dir, '.agents/skills/looks-like-agent.md', agentFile(['name: skilldoc', 'description: d']));

    expect(loadAgentsFromDir(dir, 'project').map((agent) => agent.name)).toEqual(['real']);
  });

  it('skips a skills document when the scan root is itself the .agents dir', () => {
    const dir = makeTempDir();
    const agentsDir = path.join(dir, '.agents');
    writeFile(agentsDir, 'real.md', agentFile(['name: real', 'description: d']));
    writeFile(agentsDir, 'skills/looks-like-agent.md', agentFile(['name: skilldoc', 'description: d']));

    expect(loadAgentsFromDir(agentsDir, 'project').map((agent) => agent.name)).toEqual(['real']);
  });
});

describe('loadAgentsFromDir malformed files', () => {
  it('skips a file that is documentation rather than an agent, without aborting the sweep', () => {
    const dir = makeTempDir();
    // Sorted first, so a scan that aborted here would return nothing at all.
    writeFile(dir, 'a-no-frontmatter.md', '# Just a readme\n');
    writeFile(dir, 'b-no-description.md', agentFile(['name: nameless-partner']));
    writeFile(dir, 'c-no-name.md', agentFile(['description: no name here']));
    writeFile(dir, 'd-unterminated.md', '---\nname: broken\ndescription: never closed\n');
    writeFile(dir, 'e-good.md', agentFile(['name: good', 'description: d']));

    expect(loadAgentsFromDir(dir, 'project').map((agent) => agent.name)).toEqual(['good']);
  });

  it('skips an unreadable file, since a definition can be removed mid-sweep', () => {
    const dir = makeTempDir();
    // A dangling symlink is the portable stand-in for a file that vanished
    // between the directory listing and the read.
    fs.symlinkSync(path.join(dir, 'gone.md'), path.join(dir, 'a-ghost.md'));
    writeFile(dir, 'b-good.md', agentFile(['name: good', 'description: d']));

    expect(loadAgentsFromDir(dir, 'project').map((agent) => agent.name)).toEqual(['good']);
  });

  it('skips a file whose package name cannot produce an addressable runtime name', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a-bad.md', agentFile(['name: bad', 'description: d', 'package: "***"']));
    writeFile(dir, 'b-good.md', agentFile(['name: good', 'description: d']));

    expect(loadAgentsFromDir(dir, 'project').map((agent) => agent.name)).toEqual(['good']);
  });

  it('fails loudly on an unusable timeoutMs, because that is an authoring mistake', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.md', agentFile(['name: slow', 'description: d', 'timeoutMs: soon']));

    expect(() => loadAgentsFromDir(dir, 'project')).toThrow(/invalid timeoutMs/);
  });

  it('rejects a non-positive timeoutMs', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.md', agentFile(['name: slow', 'description: d', 'timeoutMs: 0']));

    expect(() => loadAgentsFromDir(dir, 'project')).toThrow(/invalid timeoutMs/);
  });

  it('rejects a toolBudget that is not a JSON object', () => {
    const dir = makeTempDir();
    writeFile(dir, 'a.md', agentFile(['name: a', 'description: d', 'toolBudget: "[1]"']));

    expect(() => loadAgentsFromDir(dir, 'project')).toThrow(/invalid toolBudget/);
  });
});

// ============================================================================
// Plugin directories
// ============================================================================

describe('pluginAgentDirs', () => {
  it('is empty when the host staged nothing', () => {
    delete process.env[EXTRA_AGENT_DIRS_ENV];
    expect(pluginAgentDirs()).toEqual([]);
  });

  it('splits on the platform path delimiter and trims each entry', () => {
    process.env[EXTRA_AGENT_DIRS_ENV] = ['  /one/agents ', '/two/agents'].join(path.delimiter);
    expect(pluginAgentDirs()).toEqual(['/one/agents', '/two/agents']);
  });

  it('drops empty segments left by a trailing or doubled delimiter', () => {
    process.env[EXTRA_AGENT_DIRS_ENV] = `${path.delimiter}/one${path.delimiter}${path.delimiter}   ${path.delimiter}`;
    expect(pluginAgentDirs()).toEqual(['/one']);
  });

  it('re-reads the environment on every call, because a host can stage a dir late', () => {
    process.env[EXTRA_AGENT_DIRS_ENV] = '/first';
    expect(pluginAgentDirs()).toEqual(['/first']);

    process.env[EXTRA_AGENT_DIRS_ENV] = `/first${path.delimiter}/second`;
    expect(pluginAgentDirs()).toEqual(['/first', '/second']);
  });
});
