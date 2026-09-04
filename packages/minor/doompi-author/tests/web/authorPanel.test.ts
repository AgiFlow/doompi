import { describe, expect, it, vi } from 'vitest';
import type { ToolMessageRenderProps } from '@agimon-ai/doompi-web-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authorFileTab } from '../../src/web/AuthorDocumentPanel.tsx';
import { OpenAuthoringFileToolCard, openAuthoringFileTab } from '../../src/web/OpenAuthoringFileToolCard.tsx';
import { webPlugin } from '../../src/web/index.ts';

describe('the Author web plugin', () => {
  it('registers a dock face without registering a permanent workspace tab', () => {
    expect(webPlugin.tabs ?? []).toEqual([]);
    expect(webPlugin.dockFaces).toEqual([expect.objectContaining({ id: 'authoring', label: 'authoring', order: 30 })]);
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

  it('offers successful results as an explicit open action when rendering conversation history', () => {
    const props = {
      args: { path: 'docs/report.md' },
      result: { details: { path: 'docs/report.md' } },
      running: false,
      isError: false,
      openTransientTab: vi.fn(),
      openTab: vi.fn(),
    } as unknown as ToolMessageRenderProps;

    for (let mount = 0; mount < 2; mount += 1) {
      const markup = renderToStaticMarkup(createElement(OpenAuthoringFileToolCard, props));
      expect(markup).toContain('open in Author');
      expect(markup).not.toContain('opened in Author');
    }
    expect(props.openTransientTab).not.toHaveBeenCalled();
    expect(props.openTab).not.toHaveBeenCalled();
    for (const update of [{ running: true }, { isError: true }, { result: null }]) {
      const markup = renderToStaticMarkup(createElement(OpenAuthoringFileToolCard, { ...props, ...update }));
      expect(markup).not.toContain('open in Author');
    }
  });

  it('creates and focuses the successful open tool transient tab exactly once per explicit action', () => {
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
