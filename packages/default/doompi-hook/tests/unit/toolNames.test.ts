import { describe, expect, it } from 'vitest';
import { matchesTool, toClaudeToolName } from '../../src/services/toolNames.ts';

describe('tool name translation', () => {
  it('renames every Pi tool a matcher can be written against', () => {
    expect(['read', 'edit', 'write', 'bash', 'find', 'grep', 'subagent'].map((tool) => toClaudeToolName(tool))).toEqual(
      ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent'],
    );
  });

  it('passes an unmapped tool through unchanged', () => {
    expect(toClaudeToolName('mcp__github__search')).toBe('mcp__github__search');
  });

  it('tests a matcher against the Claude name rather than the Pi name', () => {
    expect(matchesTool('Bash', 'bash')).toBe(true);
    expect(matchesTool('bash', 'bash')).toBe(false);
    expect(matchesTool('Write|Edit', 'edit')).toBe(true);
    expect(matchesTool('Write', 'bash')).toBe(false);
  });

  it('accepts everything when either the matcher or the tool is absent', () => {
    expect(matchesTool(undefined, 'bash')).toBe(true);
    expect(matchesTool('Bash', undefined)).toBe(true);
  });
});
