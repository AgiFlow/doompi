import { describe, expect, it } from 'vitest';
import { toPiToolName } from '../../src/services/toolNames.ts';

describe('toPiToolName', () => {
  it('maps every Claude tool a plugin agent may declare', () => {
    const expected: Array<[string, string]> = [
      ['Read', 'read'],
      ['Edit', 'edit'],
      ['Write', 'write'],
      ['Bash', 'bash'],
      ['Glob', 'find'],
      ['Grep', 'grep'],
      ['Agent', 'subagent'],
    ];
    for (const [claudeName, piName] of expected) expect(toPiToolName(claudeName)).toBe(piName);
  });

  it('collapses web and MCP tools onto the single mcp tool', () => {
    expect(toPiToolName('WebFetch')).toBe('mcp');
    expect(toPiToolName('WebSearch')).toBe('mcp');
    expect(toPiToolName('mcp__project__list')).toBe('mcp');
    expect(toPiToolName('mcp')).toBe('mcp');
  });

  it('drops Skill, which Pi discovers rather than declares', () => {
    expect(toPiToolName('Skill')).toBeUndefined();
  });

  it('passes a name already written for Pi through unchanged', () => {
    expect(toPiToolName('subagent')).toBe('subagent');
    expect(toPiToolName('find')).toBe('find');
  });

  it('throws rather than handing Pi a tool it would silently ignore', () => {
    expect(() => toPiToolName('NotebookEdit')).toThrow('Unsupported agent tool: NotebookEdit');
  });
});
