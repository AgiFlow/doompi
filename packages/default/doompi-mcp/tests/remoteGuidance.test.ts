import { readFile } from 'node:fs/promises';

import type { DoomMcpSkill } from '@agimon-ai/doompi-core/mcpFacet';
import { describe, expect, it } from 'vitest';

import declaration from '../src/extensions/workspaces/sessions/(backend)/skill/doompi-use-mcp.mcp';

const skill = declaration as DoomMcpSkill;

describe('explicit remote mcp guidance', () => {
  it('declares a named lazy skill rather than a local registration', () => {
    expect(skill.name).toBe('doompi-use-mcp');
    expect(skill.description).not.toBe('');
    expect(skill.read).toBeTypeOf('function');
    expect(skill).not.toHaveProperty('tools');
    expect(skill).not.toHaveProperty('moduleUrl');
  });

  it('reads the explicitly selected packaged guidance without inferred fallback', async () => {
    const expected = await readFile(new URL('../src/prompts/doompi-use-mcp/SKILL.md', import.meta.url), 'utf8');

    expect(expected.trim()).not.toBe('');
    expect(await skill.read({} as Parameters<DoomMcpSkill['read']>[0])).toBe(expected);
  });
});
