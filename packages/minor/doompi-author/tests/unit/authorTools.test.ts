import { describe, expect, it, vi } from 'vitest';

import type { AuthorCatalog } from '../../src/services/authorCatalog/type';
import { createAuthorTools } from '../../src/tools/authorTools';

function fixture() {
  const catalog: AuthorCatalog = {
    open: vi.fn(async (path) => ({ path, byteLength: 12 })),
    describe: vi.fn(async () => ({ catalogToken: 'catalog', tools: [] })),
    execute: vi.fn(async (input) => ({ catalogToken: input.catalogToken, name: input.name, result: null })),
  };
  return { catalog, tools: createAuthorTools(catalog) };
}

describe('shared Author declarations', () => {
  it('declares all three tools and delegates valid paths to the catalog', async () => {
    const { catalog, tools } = fixture();
    expect(tools.map((tool) => tool.name)).toEqual([
      'open_authoring_file',
      'describe_author_tools',
      'use_author_tools',
    ]);
    const signal = new AbortController().signal;
    const result = await tools[0]!.execute(
      { path: 'docs/report.md' },
      {
        cwd: '/repo',
        toolCallId: 'call',
        signal,
        notify: () => undefined,
        update: () => undefined,
      },
    );
    expect(catalog.open).toHaveBeenCalledWith('docs/report.md', signal);
    expect(result.details).toEqual({ path: 'docs/report.md', byteLength: 12 });
  });
  it('rejects invalid input before invoking the catalog', async () => {
    const { catalog } = fixture();
    const execution = {
      cwd: '/repo',
      toolCallId: 'call',
      signal: new AbortController().signal,
      notify: () => undefined,
      update: () => undefined,
    };
    const piTool = createAuthorTools(catalog)[0]!;
    await expect(piTool.execute({}, execution)).rejects.toThrow();
    expect(catalog.open).not.toHaveBeenCalled();
  });

  it('rejects inactive-mode access before invoking the shared catalog', async () => {
    const { catalog } = fixture();
    const tools = createAuthorTools(catalog, () => {
      throw new Error('Author mode is not active.');
    });
    await expect(
      tools[1]!.execute(
        {},
        {
          cwd: '/repo',
          toolCallId: 'call',
          notify: () => undefined,
          update: () => undefined,
        },
      ),
    ).rejects.toThrow('Author mode is not active.');
    expect(catalog.describe).not.toHaveBeenCalled();
  });
});
