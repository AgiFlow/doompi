import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { api as teamApi, createTeamCatalogApi } from '../../src/controllers/teamCatalogApi';
import type { SubagentCatalogPayload } from '../../src/types/webSubagents';

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
    await expect(response.json()).resolves.toEqual({
      cwd: '/workspace/project',
      agents: [{ ...pluginAgent, fallbackModels: [], tools: [], skills: [], extensions: [], defaultContext: 'fresh' }],
      models: ['team/model'],
    });
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

  it('rejects unsupported methods and paths without reading the catalog', async () => {
    const read = vi.fn(() => ({ agents: [], models: [] }));
    const api = createTeamCatalogApi({ cwd: '/workspace/project', read });
    for (const request of [
      new Request('http://session/other'),
      new Request('http://session/catalog', { method: 'POST' }),
    ]) {
      const response = await api.fetch(request);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Not found.' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('reports non-Error failures', async () => {
    const api = createTeamCatalogApi({
      cwd: '/workspace/project',
      read: () => {
        throw 'catalog unavailable';
      },
    });
    const response = await api.fetch(new Request('http://session/catalog'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'catalog unavailable' });
  });
});

describe('session-bound catalog discovery', () => {
  it('isolates plugin agents, user settings and model policy, and refreshes edited definitions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-api-isolation-'));
    const previous = { ...process.env };
    const write = (target: string, content: string): void => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    const agent = (name: string, description: string) =>
      `---\nname: ${name}\ndescription: ${description}\n---\nPrivate system prompt.\n`;
    try {
      write(
        path.join(root, '.doom/modes.yaml'),
        `layers:
  first:
    packages:
      - name: '@agimon-ai/doompi-team'
        config:
          models: [{model: model/first}]
  second:
    packages:
      - name: '@agimon-ai/doompi-team'
        config:
          models: [{model: model/second}]
majorMode:
  copilot: [first]
`,
      );
      write(path.join(root, '.pi/agents/shared.md'), agent('shared', 'project wins'));
      const mount = (name: string) => {
        const home = path.join(root, name);
        const plugins = path.join(home, 'plugins');
        write(path.join(plugins, `${name}.md`), agent(name, `${name} plugin`));
        write(path.join(plugins, 'shared.md'), agent('shared', 'plugin loses'));
        write(path.join(home, 'agent/agents/shared.md'), agent('shared', 'user loses'));
        write(path.join(home, 'agent/agents/user.md'), agent(`user-${name}`, 'user agent'));
        const environment = {
          HOME: home,
          PI_CODING_AGENT_DIR: path.join(home, 'agent'),
          PI_SUBAGENT_EXTRA_AGENT_DIRS: plugins,
          DOOMPI_ROOT: root,
          DOOMPI_LAYERS: name,
        };
        return teamApi.start({ scope: 'session', cwd: root, environment, onNotice: vi.fn() });
      };
      const first = mount('first');
      const second = mount('second');
      const request = () => new Request('http://session/catalog');
      const a = (await (await first.fetch(request())).json()) as SubagentCatalogPayload;
      const b = (await (await second.fetch(request())).json()) as SubagentCatalogPayload;
      expect(a.agents.map((item: { name: string }) => item.name)).toEqual(['shared', 'user-first', 'first']);
      expect(b.agents.map((item: { name: string }) => item.name)).toEqual(['shared', 'user-second', 'second']);
      expect(a.models).toEqual(['model/first']);
      expect(b.models).toEqual(['model/second']);
      expect(a.agents[0]).toMatchObject({ source: 'project', description: 'project wins', model: 'model/first' });
      expect(JSON.stringify(a)).not.toContain('Private system prompt');
      write(path.join(root, 'first/plugins/first.md'), agent('first', 'edited immediately'));
      const refreshed = (await (await first.fetch(request())).json()) as SubagentCatalogPayload;
      expect(refreshed.agents.find((item: { name: string }) => item.name === 'first')?.description).toBe(
        'edited immediately',
      );
      expect(process.env).toEqual(previous);
      first.close();
      second.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
