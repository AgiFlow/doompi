import type { HubChannelHost, HubSessionScope } from '@agimon-ai/doompi-web-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createWorkflowCatalogChannel } from '../src/adapters/workflowCatalogChannel.ts';
import {
  createWorkflowCatalogReader,
  presentWorkflowCatalog,
  type CatalogDetail,
  type CatalogListEntry,
  type WorkflowCatalogReaderDeps,
} from '../src/services/webWorkflowCatalog.ts';
import type { WorkflowCatalogEntryView, WorkflowCatalogPayload } from '../src/types/webWorkflows.ts';

const BLOG: CatalogListEntry = {
  path: '/repo/automations/blog.workflow.yml',
  relativePath: 'automations/blog.workflow.yml',
  name: 'Blog Writing',
  description: 'Research, outline, draft.',
  tags: ['writing'],
};

function detail(overrides: Partial<CatalogDetail> = {}): CatalogDetail {
  return { triggers: ['workflow_dispatch'], inputs: [], jobs: [], artifacts: [], ...overrides };
}

function deps(overrides: Partial<WorkflowCatalogReaderDeps> = {}): WorkflowCatalogReaderDeps {
  return {
    list: () => Promise.resolve([BLOG]),
    summarize: () => detail(),
    stamp: () => ({ size: 10, modifiedAt: 1 }),
    ...overrides,
  };
}

describe('workflow catalog reader', () => {
  it('joins the listed entry with its parsed detail', async () => {
    const reader = createWorkflowCatalogReader(
      deps({ summarize: () => detail({ runners: ['tmux'], jobs: [{ name: 'research', steps: ['one'] }] }) }),
    );
    const entries = await reader.read('/repo');
    expect(entries).toEqual([
      {
        path: BLOG.path,
        relativePath: BLOG.relativePath,
        name: 'Blog Writing',
        description: 'Research, outline, draft.',
        tags: ['writing'],
        triggers: ['workflow_dispatch'],
        inputs: [],
        jobs: [{ name: 'research', steps: ['one'] }],
        artifacts: [],
        runners: ['tmux'],
      },
    ]);
  });

  // Parsing every file on every tick is wasted work on files that change a few
  // times a week, so an unchanged file is answered from what was parsed before.
  it('parses a file once while its size and modification time hold', async () => {
    const summarize = vi.fn(() => detail());
    const reader = createWorkflowCatalogReader(deps({ summarize }));
    await reader.read('/repo');
    await reader.read('/repo');
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('parses again once the file has been written', async () => {
    const summarize = vi.fn(() => detail());
    let modifiedAt = 1;
    const reader = createWorkflowCatalogReader(deps({ summarize, stamp: () => ({ size: 10, modifiedAt }) }));
    await reader.read('/repo');
    modifiedAt = 2;
    await reader.read('/repo');
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('falls back to the relative path when a workflow file names itself nothing', async () => {
    const reader = createWorkflowCatalogReader(deps({ list: () => Promise.resolve([{ ...BLOG, name: '' }]) }));
    expect((await reader.read('/repo'))[0]?.name).toBe(BLOG.relativePath);
  });

  it('forgets what it parsed for files that are no longer listed', async () => {
    const summarize = vi.fn(() => detail());
    const reader = createWorkflowCatalogReader(deps({ summarize }));
    await reader.read('/repo');
    reader.forget(new Set());
    await reader.read('/repo');
    expect(summarize).toHaveBeenCalledTimes(2);
  });
});

describe('presentWorkflowCatalog', () => {
  // A file that will not parse cannot be launched, so it sorts below the ones
  // that can rather than sitting in the middle of the list by name.
  it('puts launchable workflows first and orders each part by name', () => {
    const entry = (name: string, error?: string): WorkflowCatalogEntryView => ({
      path: `/repo/${name}.yml`,
      relativePath: `${name}.yml`,
      name,
      description: '',
      tags: [],
      triggers: [],
      inputs: [],
      jobs: [],
      artifacts: [],
      ...(error === undefined ? {} : { error }),
    });
    const ordered = presentWorkflowCatalog([entry('zeta'), entry('broken', 'bad yaml'), entry('alpha')]);
    expect(ordered.map((row) => row.name)).toEqual(['alpha', 'zeta', 'broken']);
  });
});

interface FakeHost extends HubChannelHost {
  published: Array<{ sessionId: string; payload: WorkflowCatalogPayload }>;
  notices: string[];
}

function fakeHost(scopes: HubSessionScope[]): FakeHost {
  const published: FakeHost['published'] = [];
  const notices: string[] = [];
  return {
    published,
    notices,
    sessions: () => scopes,
    publish: (sessionId, payload) => published.push({ sessionId, payload: payload as WorkflowCatalogPayload }),
    requestSessionApi: () => Promise.resolve(Response.json({ error: 'not implemented' }, { status: 501 })),
    onNotice: (message) => notices.push(message),
  };
}

const scope: HubSessionScope = { sessionId: 's1', cwd: '/repo' };

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('workflow catalog channel', () => {
  it('publishes a session catalog when the session arrives', async () => {
    const host = fakeHost([scope]);
    const source = createWorkflowCatalogChannel({ deps: deps() }).start(host);
    source.sessionAdded?.(scope);
    await settled();
    expect(host.published).toHaveLength(1);
    expect(host.published[0]?.payload.workflows[0]?.name).toBe('Blog Writing');
    source.close();
  });

  // A drawer that says why it is empty beats one that looks like a repository
  // with no workflows in it.
  it('publishes an empty catalog with the reason when the directory cannot be read', async () => {
    const host = fakeHost([scope]);
    const source = createWorkflowCatalogChannel({
      deps: deps({ list: () => Promise.reject(new Error('ENOENT: no such directory')) }),
    }).start(host);
    source.sessionAdded?.(scope);
    await settled();
    expect(host.published[0]?.payload).toMatchObject({ workflows: [], warning: 'ENOENT: no such directory' });
    expect(host.notices[0]).toContain('workflow catalog for /repo is unavailable');
    source.close();
  });

  it('publishes nothing more while the catalog is unchanged', async () => {
    const host = fakeHost([scope]);
    const source = createWorkflowCatalogChannel({ deps: deps() }).start(host);
    source.sessionAdded?.(scope);
    await settled();
    source.payloadFor(scope);
    await settled();
    expect(host.published).toHaveLength(1);
    source.close();
  });

  it('answers a later subscribe with the catalog it last read', async () => {
    const host = fakeHost([scope]);
    const source = createWorkflowCatalogChannel({ deps: deps() }).start(host);
    source.sessionAdded?.(scope);
    await settled();
    expect((source.payloadFor(scope) as WorkflowCatalogPayload).workflows).toHaveLength(1);
    source.close();
  });

  it('has nothing to say about a session it was never told about', () => {
    const host = fakeHost([]);
    const source = createWorkflowCatalogChannel({ deps: deps() }).start(host);
    expect(source.payloadFor(scope)).toBeUndefined();
    source.close();
  });

  it('drops a removed session', async () => {
    const host = fakeHost([scope]);
    const source = createWorkflowCatalogChannel({ deps: deps() }).start(host);
    source.sessionAdded?.(scope);
    await settled();
    source.sessionRemoved?.('s1');
    expect(source.payloadFor(scope)).toBeUndefined();
    source.close();
  });
});
