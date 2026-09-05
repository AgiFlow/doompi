import { describe, expect, it, vi } from 'vitest';
import type { ToolMessageRenderProps, WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthorDocumentPanel, authorFileTab, displayedAuthorRegions } from '../../src/web/AuthorDocumentPanel.tsx';
import { AuthorRequestLog } from '../../src/web/AuthorRequestLog.tsx';
import type { AuthorRequestRecord } from '../../src/web/authorViewportTypes.ts';
import {
  focusAuthorDocument,
  releaseAuthorDocumentFocus,
  dropAuthorSession,
} from '../../src/web/authorWorkspaceStore.ts';
import { OpenAuthoringFileToolCard, openAuthoringFileTab } from '../../src/web/OpenAuthoringFileToolCard.tsx';
import { webPlugin } from '../../src/web/index.ts';

describe('the Author web plugin', () => {
  it('registers a dock face without registering a permanent workspace tab', () => {
    expect(webPlugin.tabs ?? []).toEqual([]);
    expect(webPlugin.dockFaces).toEqual([
      expect.objectContaining({ id: 'authoring', label: 'authoring', order: 30, autoSelect: true }),
    ]);
  });
  it('requires active Author mode and reacts only to the focused session document', () => {
    const face = webPlugin.dockFaces![0]!;
    expect(face.requiredMinorMode).toBe('author');
    const listener = vi.fn();
    const release = face.visibility!.subscribe(listener);
    expect(face.visibility!.isVisible(null)).toBe(false);
    expect(face.visibility!.isVisible('gating')).toBe(false);
    const generation = focusAuthorDocument('gating', 'doc.md', 0, 'sha');
    expect(listener).toHaveBeenCalled();
    expect(face.visibility!.isVisible('gating')).toBe(true);
    expect(face.visibility!.isVisible('another-session')).toBe(false);
    releaseAuthorDocumentFocus('gating', generation);
    expect(face.visibility!.isVisible('gating')).toBe(false);
    release();
    dropAuthorSession('gating');
  });
  it.each([undefined, [], ['voice']])(
    'withholds document editing without Author activation: %j',
    (activeMinorModes) => {
      const props = { sessionId: 'gating', path: 'doc.md', activeMinorModes } as unknown as WebPluginSlotProps & {
        path: string;
      };
      const markup = renderToStaticMarkup(createElement(AuthorDocumentPanel, props));
      expect(markup).toContain('author-mode-inactive');
      expect(markup).not.toContain('author-save');
      expect(markup).not.toContain('author-document');
    },
  );
  it('admits the document loader when Author is active', () => {
    const props = {
      sessionId: 'gating',
      path: 'doc.md',
      activeMinorModes: ['author'],
    } as unknown as WebPluginSlotProps & {
      path: string;
    };
    const markup = renderToStaticMarkup(createElement(AuthorDocumentPanel, props));
    expect(markup).toContain('Loading document');
    expect(markup).not.toContain('author-mode-inactive');
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

  it('keeps stable visible numbers for draft and pending document regions', () => {
    const first = {
      id: 'first',
      documentPath: 'docs/report.md',
      revision: 0,
      comment: 'First',
      quote: 'alpha',
      anchor: { kind: 'text-range' as const, startOffset: 0, endOffset: 5, startLine: 1, endLine: 1 },
      viewport: { width: 800, height: 600 },
      createdAt: 1,
    };
    const second = {
      ...first,
      id: 'second',
      comment: 'Second',
      quote: 'beta',
      anchor: { ...first.anchor, startOffset: 6, endOffset: 10 },
    };

    expect(
      displayedAuthorRegions({ generation: 0, activeTool: 'select', regions: [first, second], requests: [] }).map(
        ({ ordinal, region }) => [ordinal, region.id],
      ),
    ).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
    expect(
      displayedAuthorRegions({
        generation: 0,
        activeTool: 'select',
        regions: [],
        requests: [
          {
            id: 'request',
            documentPath: 'docs/report.md',
            requestText: 'change both',
            regions: [first, second],
            pendingRegions: [second],
            status: 'CHANGING',
            createdAt: 1,
            updatedAt: 2,
            revision: 1,
          },
        ],
      }).map(({ ordinal, region }) => [ordinal, region.id]),
    ).toEqual([[2, 'second']]);
  });
  it('presents the latest Author lifecycle with clean instruction and retained earlier history', () => {
    const region = {
      id: 'region-1',
      documentPath: 'docs/report.md',
      revision: 4,
      comment: 'Tighten the opening',
      quote: 'A long introduction',
      anchor: { kind: 'text-range' as const, startOffset: 0, endOffset: 19, startLine: 2, endLine: 3 },
      viewport: { width: 800, height: 600 },
      createdAt: 1,
    };
    const earlier: AuthorRequestRecord = {
      id: 'earlier',
      documentPath: 'docs/old.md',
      requestText: 'Earlier instruction',
      regions: [{ ...region, id: 'old-region', documentPath: 'docs/old.md' }],
      status: 'COMPLETE',
      createdAt: 1,
      updatedAt: 2,
      revision: 3,
    };
    const latest: AuthorRequestRecord = {
      id: 'latest',
      documentPath: 'docs/report.md',
      requestText: 'Make the opening direct. Referenced context "Author selection":\n\n{"private":"capture"}',
      regions: [region],
      pendingRegions: [region],
      status: 'CHANGING',
      currentOperation: 'Replacing selected introduction',
      createdAt: 3,
      updatedAt: 4,
      revision: 4,
    };

    const markup = renderToStaticMarkup(createElement(AuthorRequestLog, { requests: [earlier, latest] }));

    expect(markup).toContain('author-active-request');
    expect(markup).toContain('DOCUMENT CONTEXT');
    expect(markup).toContain('REQUEST · HOW TO CHANGE');
    expect(markup).toContain('report.md');
    expect(markup).toContain('Lines 2–3');
    expect(markup).toContain('A long introduction');
    expect(markup).toContain('● CHANGING');
    expect(markup).toContain('Replacing selected introduction');
    expect(markup).toContain('Make the opening direct.');
    expect(markup).toContain('0 of 1 regions applied');
    expect(markup).not.toContain('Referenced context');
    expect(markup).not.toContain('&quot;private&quot;');
    expect(markup).toContain('EARLIER REQUESTS (1)');
    expect(markup.indexOf('report.md')).toBeLessThan(markup.indexOf('old.md'));
  });
});
