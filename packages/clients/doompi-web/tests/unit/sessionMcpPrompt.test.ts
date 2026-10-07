import { describe, expect, it } from 'vitest';

import { sessionMcpRemoteToolName, sessionMcpToolsPrompt } from '../../src/web/lib/sessionMcpPrompt';

const PREAMBLE = [
  'Use the DoomPi MCP tools below for work in the DoomPi session repository. They run on the DoomPi host, not on your local machine.',
  'Prefer them over your built-in bash, read, edit, write, grep, find, or ls tools for that repository.',
];

const tools = [
  { name: 'load_context', description: 'Load the session context.' },
  { name: 'bash', description: 'Run a shell\n  command\tin the repo.  ' },
  { name: 'load_extra_tools', description: 'List added tools.' },
  { name: 'use_extra_tools', description: 'Run an added tool.' },
];

describe('sessionMcpToolsPrompt', () => {
  it('applies the prefix to every tool name and states it once', () => {
    expect(sessionMcpToolsPrompt(tools, 'repo').split('\n')).toEqual([
      ...PREAMBLE,
      'Every tool name starts with "repo_".',
      'Start each task with repo_load_context.',
      'If a tool below is missing from your tool list, call repo_load_extra_tools, then run it with repo_use_extra_tools.',
      '',
      'Tools:',
      '- repo_load_context: Load the session context.',
      '- repo_bash: Run a shell command in the repo.',
      '- repo_load_extra_tools: List added tools.',
      '- repo_use_extra_tools: Run an added tool.',
    ]);
  });

  it('omits the prefix line and keeps bare names on an unprefixed connection', () => {
    for (const prefix of [undefined, '']) {
      const prompt = sessionMcpToolsPrompt(tools, prefix);
      expect(prompt).not.toContain('Every tool name starts with');
      expect(prompt).toContain('Start each task with load_context.');
      expect(prompt).toContain('- bash: Run a shell command in the repo.');
    }
  });

  it('adds the conditional lines only when their tools are listed', () => {
    const bare = [{ name: 'bash', description: 'Run.' }];
    expect(sessionMcpToolsPrompt(bare, 'p').split('\n')).toEqual([
      ...PREAMBLE,
      'Every tool name starts with "p_".',
      '',
      'Tools:',
      '- p_bash: Run.',
    ]);
    const loadOnly = sessionMcpToolsPrompt([...bare, { name: 'load_extra_tools', description: 'List.' }], 'p');
    expect(loadOnly).not.toContain('If a tool below is missing');
    expect(loadOnly).not.toContain('Start each task');
    const useOnly = sessionMcpToolsPrompt([...bare, { name: 'use_extra_tools', description: 'Use.' }], 'p');
    expect(useOnly).not.toContain('If a tool below is missing');
  });

  it('collapses whitespace inside descriptions to single spaces', () => {
    const prompt = sessionMcpToolsPrompt([{ name: 'read', description: '\n Read\r\n\n a   file.\t' }]);
    expect(prompt.endsWith('- read: Read a file.')).toBe(true);
  });

  it('lists every tool it is given, in order', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ name: `tool_${index}`, description: `d${index}` }));
    const lines = sessionMcpToolsPrompt(many, 'p').split('\n');
    const listed = lines.slice(lines.indexOf('Tools:') + 1);
    expect(listed).toEqual(many.map((tool) => `- p_${tool.name}: ${tool.description}`));
  });

  it('maps internal names to remote names', () => {
    expect(sessionMcpRemoteToolName('bash', 'repo')).toBe('repo_bash');
    expect(sessionMcpRemoteToolName('bash')).toBe('bash');
  });
});
