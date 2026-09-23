import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createTeamApiHandler,
  createTeamSessionApi,
} from '../../src/extensions/workspaces/sessions/(backend)/api/_lib/route.server';
import { DoomTeamExpectedError } from '../../src/services/errors';
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
    const api = createTeamApiHandler({ cwd: '/workspace/project', read });

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
    const api = createTeamApiHandler({
      cwd: '/workspace/project',
      read: () => {
        throw new Error('bad projected agent');
      },
    });

    const response = await api.fetch(new Request('http://session/catalog'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'bad projected agent' });
  });

  it('validates and dispatches a direct run request', async () => {
    const launch = vi.fn(async () => ({ runId: 'run-1' }));
    const handler = createTeamApiHandler({ cwd: '/workspace/project', launch });
    const request = (body: unknown) =>
      new Request('http://session/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const accepted = await handler.fetch(request({ agent: 'reviewer', task: 'Review', fork: false }));
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toEqual({ runId: 'run-1' });
    expect(launch).toHaveBeenCalledWith({ agent: 'reviewer', task: 'Review', fork: false });

    const invalid = await handler.fetch(request({ agent: '', task: 'Review', fork: false }));
    expect(invalid.status).toBe(400);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('rejects malformed input and reports a failed server launch', async () => {
    const launch = vi.fn(async () => {
      throw new Error('Agent is unavailable.');
    });
    const handler = createTeamApiHandler({ cwd: '/workspace/project', launch });
    const malformed = await handler.fetch(new Request('http://session/run', { method: 'POST', body: '{' }));
    expect(malformed.status).toBe(400);
    expect(launch).not.toHaveBeenCalled();

    const failed = await handler.fetch(
      new Request('http://session/run', {
        method: 'POST',
        body: JSON.stringify({ agent: 'reviewer', task: 'Review', fork: true }),
      }),
    );
    expect(failed.status).toBe(409);
    await expect(failed.json()).resolves.toEqual({ error: 'Agent is unavailable.' });
  });

  it('rejects unsupported methods and paths without reading the catalog', async () => {
    const read = vi.fn(() => ({ agents: [], models: [] }));
    const api = createTeamApiHandler({ cwd: '/workspace/project', read });
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
    const api = createTeamApiHandler({
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

describe('the Team session control API', () => {
  const post = (route: string, body: unknown) =>
    new Request(`http://session${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const delivered = {
    requestId: 'req-1',
    index: 0,
    state: 'delivered' as const,
    message: 'Native child accepted the steer request.',
  };

  it('steers a run with trimmed input and the request signal', async () => {
    const steer = vi.fn(async () => delivered);
    const handler = createTeamApiHandler({ cwd: '/workspace/project', steer });

    const response = await handler.fetch(post('/steer', { runId: ' run-1 ', message: '  focus on tests  ' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(delivered);
    expect(steer).toHaveBeenCalledWith({ runId: 'run-1', message: 'focus on tests' }, expect.any(AbortSignal));
  });

  it('passes a refused or unacknowledged steer through as a result', async () => {
    for (const state of ['failed', 'pending'] as const) {
      const result = { requestId: 'req-2', index: 0, state, message: `child said ${state}` };
      const handler = createTeamApiHandler({ cwd: '/workspace/project', steer: async () => result });
      const response = await handler.fetch(post('/steer', { runId: 'run-1', message: 'go' }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(result);
    }
  });

  it('rejects malformed steer input without steering', async () => {
    const steer = vi.fn(async () => delivered);
    const handler = createTeamApiHandler({ cwd: '/workspace/project', steer });
    for (const body of [
      '{',
      [],
      { runId: 'run-1' },
      { runId: 'run-1', message: '   ' },
      { runId: '', message: 'go' },
      { runId: 1, message: 'go' },
      { runId: 'run-1', message: 'go', targetIndex: 1 },
    ]) {
      const response = await handler.fetch(post('/steer', body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid steer request.' });
    }
    expect(steer).not.toHaveBeenCalled();
  });

  it('maps an inactive run to 404 and any other failure to 409', async () => {
    const cases: Array<[unknown, number, string]> = [
      [
        new DoomTeamExpectedError('run_not_found', "No active run matches 'run-1'.", false, 'retry'),
        404,
        'This run is not active.',
      ],
      [new Error("Child run 'run-1' is no longer active."), 409, "Child run 'run-1' is no longer active."],
      ['offline', 409, 'offline'],
    ];
    for (const [failure, status, error] of cases) {
      const handler = createTeamApiHandler({
        cwd: '/workspace/project',
        steer: async () => {
          throw failure;
        },
      });
      const response = await handler.fetch(post('/steer', { runId: 'run-1', message: 'go' }));
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  it('stops a run, validates the request and reports an inactive run', async () => {
    const stop = vi.fn(async () => ({ requestId: 'req-stop' }));
    const handler = createTeamApiHandler({ cwd: '/workspace/project', stop });

    const accepted = await handler.fetch(post('/stop', { runId: ' run-1 ' }));
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ requestId: 'req-stop' });
    expect(stop).toHaveBeenCalledWith({ runId: 'run-1' });

    for (const body of ['{', { runId: '' }, { runId: 'run-1', reason: 'x' }]) {
      const response = await handler.fetch(post('/stop', body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid stop request.' });
    }
    expect(stop).toHaveBeenCalledOnce();

    const gone = createTeamApiHandler({
      cwd: '/workspace/project',
      stop: async () => {
        throw new DoomTeamExpectedError('run_not_found', "Native run 'run-1' is no longer active.", false, 'retry');
      },
    });
    const missing = await gone.fetch(post('/stop', { runId: 'run-1' }));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: 'This run is not active.' });
  });

  it('keeps the control routes closed when unwired or called with the wrong method', async () => {
    const unwired = createTeamApiHandler({ cwd: '/workspace/project' });
    const wired = createTeamApiHandler({
      cwd: '/workspace/project',
      steer: async () => delivered,
      stop: async () => ({ requestId: 'req-stop' }),
    });
    const cases: Array<[typeof wired, Request]> = [
      [unwired, post('/steer', { runId: 'run-1', message: 'go' })],
      [unwired, post('/stop', { runId: 'run-1' })],
      [wired, new Request('http://session/steer')],
      [wired, new Request('http://session/stop')],
    ];
    for (const [handler, request] of cases) {
      const response = await handler.fetch(request);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Not found.' });
    }
  });

  it('wires steer and stop to the session management runtime', async () => {
    const management = {
      steer: vi.fn(async () => delivered),
      stop: vi.fn(async () => ({ requestId: 'req-stop' })),
    };
    const runtime = {
      management,
      asyncJobTracker: { forSession: () => ({ track: vi.fn() }) },
    } as unknown as Parameters<typeof createTeamSessionApi>[0];
    const execution = {
      sessionId: 'session-1',
      cwd: '/workspace/project',
      environment: {},
    } as unknown as Parameters<typeof createTeamSessionApi>[1];
    const handler = createTeamSessionApi(runtime, execution).start({} as never);

    expect((await handler.fetch(post('/steer', { runId: 'run-1', message: 'go' }))).status).toBe(200);
    expect((await handler.fetch(post('/stop', { runId: 'run-1' }))).status).toBe(200);

    expect(management.steer).toHaveBeenCalledWith('run-1', 'go', undefined, expect.any(AbortSignal));
    expect(management.stop).toHaveBeenCalledWith('run-1');
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
        return createTeamApiHandler({ cwd: root, environment });
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
