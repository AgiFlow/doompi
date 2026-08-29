import type { HubChannelHost } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createSubagentCatalogChannel } from '../../src/adapters/webSubagentCatalogChannel.ts';
import type { CatalogAgentInput } from '../../src/services/webSubagentCatalog.ts';
import type { SubagentCatalogPayload } from '../../src/types/webSubagents.ts';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface FakeHost extends HubChannelHost {
  published: Array<{ sessionId: string; payload: SubagentCatalogPayload }>;
  notices: string[];
}

function fakeHost(): FakeHost {
  const published: FakeHost['published'] = [];
  const notices: string[] = [];
  return {
    published,
    notices,
    sessions: () => [{ sessionId: 's1', cwd: '/w' }],
    publish: (sessionId, payload) => published.push({ sessionId, payload: payload as SubagentCatalogPayload }),
    requestSessionApi: () => Promise.resolve(Response.json({ error: 'not implemented' }, { status: 501 })),
    onNotice: (message) => notices.push(message),
  };
}

const agent = (name: string, source: CatalogAgentInput['source']): CatalogAgentInput => ({
  name,
  source,
  description: `${name} does things`,
  filePath: `/x/${name}.md`,
});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(15);
  }
};

describe('the subagent catalog hub channel', () => {
  it('publishes the catalog on arrival, answers snapshots, and publishes only changes on the tick', async () => {
    const host = fakeHost();
    let agents = [agent('reviewer', 'project')];
    let reads = 0;
    const channel = createSubagentCatalogChannel((cwd) => {
      reads += 1;
      return { agents: cwd === '/w' ? agents : [], models: ['t1'] };
    }, 20);
    const source = channel.start(host);
    cleanups.push(() => source.close());
    expect(channel.frameType).toBe('subagent_catalog');

    source.sessionAdded?.({ sessionId: 's1', cwd: '/w' });
    expect(host.published).toHaveLength(1);
    expect(host.published[0]).toMatchObject({ sessionId: 's1', payload: { cwd: '/w', models: ['t1'] } });
    expect(host.published[0]?.payload.agents.map((row) => row.name)).toEqual(['reviewer']);

    // A snapshot re-reads for the subscriber but does not publish again.
    const readsBefore = reads;
    expect(source.payloadFor({ sessionId: 's1', cwd: '/w' })).toMatchObject({ cwd: '/w' });
    expect(reads).toBe(readsBefore + 1);
    expect(source.payloadFor({ sessionId: 'nobody', cwd: '/w' })).toBeUndefined();
    await sleep(70);
    expect(host.published).toHaveLength(1);

    agents = [...agents, agent('scout', 'user')];
    await waitFor(() => host.published.length === 2, 'the change publishing');
    expect(host.published[1]?.payload.agents.map((row) => row.name)).toEqual(['reviewer', 'scout']);

    source.sessionRemoved?.('s1');
    expect(source.payloadFor({ sessionId: 's1', cwd: '/w' })).toBeUndefined();
  });

  it('publishes an empty catalog with the reason when discovery fails, noticing once', () => {
    const host = fakeHost();
    const channel = createSubagentCatalogChannel(() => {
      throw new Error('bad frontmatter');
    }, 1_000_000);
    const source = channel.start(host);
    cleanups.push(() => source.close());

    source.sessionAdded?.({ sessionId: 's1', cwd: '/w' });
    expect(host.published[0]?.payload).toEqual({ cwd: '/w', agents: [], models: [], warning: 'bad frontmatter' });
    expect(host.notices).toHaveLength(1);
    source.payloadFor({ sessionId: 's1', cwd: '/w' });
    expect(host.notices).toHaveLength(1);
  });
});
