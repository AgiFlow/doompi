import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { createContextPublisher } from '../../src/services/contextCatalog.ts';

/** Neither the MCP status nor the skill-source service is provided here. */
const cordis = { get: () => undefined } as unknown as Context;

function harness(tools: { name: string; description?: string }[]) {
  const appended: { type: string; data: unknown }[] = [];
  const pi = {
    getAllTools: () => tools.map((tool) => ({ ...tool, sourceInfo: { path: '/x/pi.mjs', source: 'builtin' } })),
    getActiveTools: () => tools.map((tool) => tool.name),
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
  } as unknown as ExtensionAPI;
  return { pi, appended };
}

describe('createContextPublisher', () => {
  it('journals the composition under the entry type the cockpit reads', async () => {
    const { pi, appended } = harness([{ name: 'read', description: 'Reads a file' }]);

    await createContextPublisher(pi, cordis).publish();

    expect(appended).toHaveLength(1);
    expect(appended[0]?.type).toBe('doom-context');
    const projection = appended[0]?.data as { groups: unknown[]; totalTokens: number; estimator: string };
    expect(projection.estimator).toBe('gpt-tokenizer');
    expect(projection.groups.length).toBeGreaterThan(0);
    expect(projection.totalTokens).toBeGreaterThan(0);
  });

  it('prices a Pi builtin into the core group', async () => {
    const { pi, appended } = harness([{ name: 'read', description: 'Reads a file' }]);

    await createContextPublisher(pi, cordis).publish();

    const projection = appended[0]?.data as {
      groups: { kind: string; items: { name: string; tokens: number }[] }[];
    };
    const core = projection.groups.find((group) => group.kind === 'core');
    expect(core?.items.map((item) => item.name)).toContain('read');
    expect(core?.items.find((item) => item.name === 'read')?.tokens).toBeGreaterThan(0);
  });

  // Republishing happens whenever a mode flips, which is far more often than
  // the toolbox actually changes. An identical payload must stay off the journal.
  it('says nothing when the composition has not changed', async () => {
    const { pi, appended } = harness([{ name: 'read' }]);
    const publisher = createContextPublisher(pi, cordis);

    await publisher.publish();
    await publisher.publish();
    await publisher.publish();

    expect(appended).toHaveLength(1);
  });

  it('publishes again once the toolbox really changes', async () => {
    const tools = [{ name: 'read' }];
    const appended: { type: string; data: unknown }[] = [];
    const pi = {
      getAllTools: () => tools.map((tool) => ({ ...tool, sourceInfo: { path: '/x/pi.mjs', source: 'builtin' } })),
      getActiveTools: () => tools.map((tool) => tool.name),
      appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    } as unknown as ExtensionAPI;
    const publisher = createContextPublisher(pi, cordis);

    await publisher.publish();
    tools.push({ name: 'bash' });
    await publisher.publish();

    expect(appended).toHaveLength(2);
    expect(appended[1]?.data).toMatchObject({ revision: 2 });
  });

  it('goes quiet after disposal', async () => {
    const { pi, appended } = harness([{ name: 'read' }]);
    const publisher = createContextPublisher(pi, cordis);

    publisher.dispose();
    await publisher.publish();

    expect(appended).toHaveLength(0);
  });
});
