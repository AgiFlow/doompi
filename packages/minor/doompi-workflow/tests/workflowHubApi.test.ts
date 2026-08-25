import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowRegistryService, WorkflowRunRecord } from '@agimon-ai/workflow-mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowHubApi } from '../src/adapters/workflowHubApi.ts';
import type {
  WorkflowArtifactContentResponse,
  WorkflowArtifactsResponse,
  WorkflowControlResponse,
} from '../src/types/webWorkflowTerminal.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function runDirectory(files: Record<string, string> = {}): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-api-'));
  directories.push(directory);
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents);
  return directory;
}

function record(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    displayName: 'blog-writing',
    dryRun: false,
    runKey: 'blog-writing-4',
    stage: 'running',
    startedAt: new Date(0).toISOString(),
    workflowPath: '/repo/blog.workflow.yml',
    workspace: 'repo',
    launcher: { type: 'tmux', sessionName: 'workflow-blog-writing', paneId: '%7' },
    ...overrides,
  } as WorkflowRunRecord;
}

/** A registry standing in for the filesystem one, answering for a single run. */
function fakeRegistry(current: WorkflowRunRecord, runDir: string): WorkflowRegistryService {
  return {
    readRunByKey: (_workspace: string | undefined, stage: string, runKey: string) =>
      stage === current.stage && runKey === current.runKey
        ? Promise.resolve(current)
        : Promise.reject(new Error('not found')),
    runDirectoryFor: () => runDir,
  } as unknown as WorkflowRegistryService;
}

const WRITABLE = { readable: true, writable: true, resizable: true };

function fakeTerminal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    capabilities: () => WRITABLE,
    screen: () => Promise.resolve(['one', 'two']),
    write: vi.fn(() => Promise.resolve()),
    resize: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

function api(current = record(), runDir = runDirectory(), terminal = fakeTerminal()) {
  const app = createWorkflowHubApi({
    registry: fakeRegistry(current, runDir),
    // The facade is a class in the engine; the routes only use these four.
    terminal: terminal as never,
    now: () => 1_000,
  });
  return { app, runDir, terminal };
}

const BASE = 'http://hub/runs/repo/blog-writing-4';

describe('workflow hub api: control and keys', () => {
  it('hands out a control token and takes the keystrokes that carry it', async () => {
    const { app, terminal } = api();
    const taken = await app.request(`${BASE}/control`, { method: 'POST', body: '{}' });
    expect(taken.status).toBe(200);
    const control = (await taken.json()) as WorkflowControlResponse;
    expect(control.held).toBe(true);

    const typed = await app.request(`${BASE}/keys`, {
      method: 'POST',
      body: JSON.stringify({ token: control.token, data: 'y\r' }),
    });
    expect(typed.status).toBe(204);
    expect(terminal.write).toHaveBeenCalledWith(expect.anything(), 'y\r');
  });

  // The whole point of the lease: a second tab watching the same run must not
  // be able to type into it while somebody else is answering a prompt.
  it('refuses a keystroke that carries no lease', async () => {
    const { app, terminal } = api();
    const refused = await app.request(`${BASE}/keys`, {
      method: 'POST',
      body: JSON.stringify({ token: 'not-the-holder', data: 'y' }),
    });
    expect(refused.status).toBe(409);
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('refuses control for a run whose terminal cannot be driven', async () => {
    const { app } = api(
      record(),
      runDirectory(),
      fakeTerminal({
        capabilities: () => ({ readable: false, writable: false, resizable: false, reason: 'hosted natively' }),
      }),
    );
    const refused = await app.request(`${BASE}/control`, { method: 'POST', body: '{}' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as WorkflowControlResponse).reason).toBe('hosted natively');
  });

  it('gives control to the next reader once the holder releases it', async () => {
    const { app } = api();
    const first = (await (
      await app.request(`${BASE}/control`, { method: 'POST', body: '{}' })
    ).json()) as WorkflowControlResponse;
    await app.request(`${BASE}/control`, {
      method: 'POST',
      body: JSON.stringify({ token: first.token, release: true }),
    });
    const second = await app.request(`${BASE}/control`, { method: 'POST', body: '{}' });
    expect(second.status).toBe(200);
  });

  it('answers 404 for a run the registry does not have', async () => {
    const { app } = api();
    const missing = await app.request('http://hub/runs/repo/no-such-run/control', { method: 'POST', body: '{}' });
    expect(missing.status).toBe(404);
  });

  // The run key reaches the registry, so a segment that could climb out of it
  // is refused before any path is built.
  it('refuses a run key that is not a plain segment', async () => {
    const { app } = api();
    const climbing = await app.request('http://hub/runs/repo/..%2F..%2Fetc/control', { method: 'POST', body: '{}' });
    expect(climbing.status).toBe(404);
  });
});

describe('workflow hub api: artifacts', () => {
  it('lists the declared entries first, with what is on disk beside them', async () => {
    const runDir = runDirectory({ 'research.md': 'facts', 'context.md': 'the prompt' });
    const { app } = api(
      record({
        runDirectory: {
          description: 'Drafts and evidence.',
          entries: [
            { path: 'research.md', kind: 'file', description: 'Verified facts.', 'produced-by': ['research'] },
            { path: 'post.md', kind: 'file', description: 'The article.', 'produced-by': ['finalize'] },
          ],
        },
      } as Partial<WorkflowRunRecord>),
      runDir,
    );
    const listed = (await (await app.request(`${BASE}/artifacts`)).json()) as WorkflowArtifactsResponse;
    expect(listed.description).toBe('Drafts and evidence.');
    expect(listed.artifacts.map((entry) => [entry.path, entry.state, entry.declared])).toEqual([
      ['research.md', 'written', true],
      ['post.md', 'pending', true],
      ['context.md', 'written', false],
    ]);
    expect(listed.artifacts[0]?.size).toBe(5);
  });

  it('reads one artifact', async () => {
    const { app } = api(record(), runDirectory({ 'post.md': '# title' }));
    const response = await app.request(`${BASE}/artifacts/post.md`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as WorkflowArtifactContentResponse).text).toBe('# title');
  });

  it('answers 404 for a declared artifact no job has written yet', async () => {
    const { app } = api(record(), runDirectory());
    expect((await app.request(`${BASE}/artifacts/post.md`)).status).toBe(404);
  });

  // The path is supplied verbatim, so without this check the route would read
  // any file the hub process can reach.
  it('refuses a path that resolves outside the run directory', async () => {
    const { app } = api(record(), runDirectory({ 'post.md': 'x' }));
    const escaped = await app.request(`${BASE}/artifacts/..%2F..%2Fetc%2Fpasswd`);
    expect(escaped.status).toBe(400);
  });
});
