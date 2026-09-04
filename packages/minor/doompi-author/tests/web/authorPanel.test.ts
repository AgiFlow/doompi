import { describe, expect, it, vi } from 'vitest';
import { authorFileTab } from '../../src/web/AuthorDocumentPanel.tsx';
import { openAuthoringFileTab } from '../../src/web/OpenAuthoringFileToolCard.tsx';
import { webPlugin } from '../../src/web/index.ts';

describe('the Author web plugin', () => {
  it('does not register a permanent workspace tab', () => {
    expect(webPlugin.tabs ?? []).toEqual([]);
  });

  it('uses the standard minor-mode row and SPC o a toggle binding', () => {
    expect(webPlugin.minorModes).toEqual([{ name: 'author', keys: 'o a', order: 45 }]);
    expect(webPlugin.leaderBindings).toEqual([
      expect.objectContaining({ id: 'author.toggle', command: 'minor author' }),
    ]);
  });
  it('opens documents as closeable retained-Composer tabs', () => {
    expect(authorFileTab('docs/report.md')).toMatchObject({
      label: 'report.md',
      retainComposer: true,
    });
  });

  it('creates and focuses the successful open tool transient tab exactly once per renderer action', () => {
    const openTransientTab = vi.fn();
    const openTab = vi.fn();
    openAuthoringFileTab('docs/report.md', openTransientTab, openTab);

    expect(openTransientTab).toHaveBeenCalledOnce();
    const tab = openTransientTab.mock.calls[0]![0];
    expect(tab).toMatchObject({ label: 'report.md', retainComposer: true });
    expect(openTab).toHaveBeenCalledOnce();
    expect(openTab).toHaveBeenCalledWith(tab.id);
    expect(webPlugin.toolRenderers).toEqual(
      expect.arrayContaining([expect.objectContaining({ tools: ['open_authoring_file'] })]),
    );
  });
});
