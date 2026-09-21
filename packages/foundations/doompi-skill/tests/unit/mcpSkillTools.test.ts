import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import { describe, expect, it, vi } from 'vitest';

import { createLoadSkillTool, createSearchSkillsTool } from '../../src/services/mcpSkillTools';

function context(skills?: DoomHeadlessExecutionContext['mcpSkills']) {
  return { mcpSkills: skills } as DoomHeadlessExecutionContext;
}

describe('remote skill tools', () => {
  it('searches the grant-filtered skill catalog without loading content', async () => {
    const available = [
      { name: 'release', description: 'Prepare a release' },
      { name: 'testing', description: 'Run focused checks' },
    ];
    const list = vi.fn(async () => available);
    const read = vi.fn();
    const tool = createSearchSkillsTool();
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

    await expect(tool.execute('call', {}, undefined, undefined, context({ list, read }))).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify(available) }],
      structuredContent: { skills: available },
    });
    await expect(
      tool.execute('call', { query: 'RELEASE' }, undefined, undefined, context({ list, read })),
    ).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify([{ name: 'release', description: 'Prepare a release' }]) }],
      structuredContent: { skills: [{ name: 'release', description: 'Prepare a release' }] },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('loads only the exact skill name through the remote capability', async () => {
    const read = vi.fn(async (name: string) => `# ${name}`);
    const tool = createLoadSkillTool();
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

    await expect(
      tool.execute('call', { name: 'release' }, undefined, undefined, context({ list: async () => [], read })),
    ).resolves.toEqual({
      content: [{ type: 'text', text: '# release' }],
    });
    expect(read).toHaveBeenCalledWith('release');
  });

  it('fails closed outside a remote MCP invocation', async () => {
    await expect(createSearchSkillsTool().execute('call', {}, undefined, undefined, context())).rejects.toThrow(
      'Remote skill access is unavailable.',
    );
    await expect(
      createLoadSkillTool().execute('call', { name: '../secret' }, undefined, undefined, context()),
    ).rejects.toThrow('Remote skill access is unavailable.');
  });
});
