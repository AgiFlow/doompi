import { describe, expect, it, vi } from 'vitest';
import { createTeamCatalogApi } from '../../src/adapters/teamCatalogApi.ts';

const pluginAgent = {
  name: 'plugins.reviewer',
  source: 'plugin' as const,
  description: 'Reviews changes.',
  filePath: '/projection/agents/reviewer.md',
};

describe('the Team session catalog API', () => {
  it('discovers from the session cwd and returns plugin agents', async () => {
    const read = vi.fn(() => ({ agents: [pluginAgent], models: ['team/model'] }));
    const api = createTeamCatalogApi({ cwd: '/workspace/project', read });

    const response = await api.fetch(new Request('http://session/catalog'));

    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith('/workspace/project');
    await expect(response.json()).resolves.toEqual({ agents: [pluginAgent], models: ['team/model'] });
  });

  it('keeps discovery failures visible to the hub', async () => {
    const api = createTeamCatalogApi({
      cwd: '/workspace/project',
      read: () => {
        throw new Error('bad projected agent');
      },
    });

    const response = await api.fetch(new Request('http://session/catalog'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'bad projected agent' });
  });
});
