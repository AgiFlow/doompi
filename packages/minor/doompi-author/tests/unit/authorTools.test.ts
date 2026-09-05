import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerAuthorToolFacades } from '../../src/adapters/pi/authorTools.ts';
import type { AuthorCatalog } from '../../src/services/authorCatalog.ts';

function fixture(active = true) {
  const tools = new Map<string, ToolDefinition>();
  const catalog: AuthorCatalog = {
    open: vi.fn(async (path) => ({ path, byteLength: 12 })),
    describe: vi.fn(async () => ({ catalogToken: 'catalog', tools: [] })),
    execute: vi.fn(async (input) => ({ catalogToken: input.catalogToken, name: input.name, result: null })),
  };
  const registration = registerAuthorToolFacades(
    { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as Pick<ExtensionAPI, 'registerTool'>,
    catalog,
    () => active,
  );
  return { catalog, registration, tools };
}

describe('Author Pi tools', () => {
  it('registers all three tools and validates open paths through the catalog', async () => {
    const h = fixture();
    expect([...h.tools.keys()]).toEqual(['open_authoring_file', 'describe_author_tools', 'use_author_tools']);

    const result = await h.tools
      .get('open_authoring_file')!
      .execute('call', { path: 'docs/report.md' }, new AbortController().signal, () => undefined, {} as never);
    expect(h.catalog.open).toHaveBeenCalledWith('docs/report.md', expect.any(AbortSignal));
    expect(result.details).toEqual({ path: 'docs/report.md', byteLength: 12 });
    h.registration.dispose();
  });
});
