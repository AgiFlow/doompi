import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { AuthorToolPalette } from '../../src/web/AuthorToolPalette.tsx';
import { AuthorRegionDrafts } from '../../src/web/AuthorRegionDrafts.tsx';
import { AuthorStructuredView } from '../../src/web/AuthorStructuredView.tsx';
import * as workspace from '../../src/web/authorWorkspaceStore.ts';
import {
  authorGrid,
  resolveAuthorGridCell,
  resolveAuthorGridNativeAnchor,
  updateAuthorGridGeometry,
} from '../../src/web/authorGrid.ts';
import type { AuthorRegionDraft } from '../../src/web/authorViewportTypes.ts';

const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  setters: [] as ReturnType<typeof vi.fn>[],
  cleanups: [] as (() => void)[],
}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    hooks.setters.push(setter);
    return [hooks.values.length ? hooks.values.shift() : initial, setter];
  },
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
}));
type Props = {
  children?: ReactNode;
  'aria-label'?: string;
  disabled?: boolean;
  onClick?: (event: { currentTarget: { getBoundingClientRect: () => { width: number; height: number } } }) => void;
  onChange?: (event: { target: { value: string } }) => void;
};
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
const event = { currentTarget: { getBoundingClientRect: () => ({ width: 80, height: 30 }) } };
const region: AuthorRegionDraft = {
  id: 'r',
  documentPath: 'doc',
  revision: 0,
  sourceSha256: 'sha',
  comment: 'Edit',
  quote: 'abc',
  anchor: { kind: 'text-range', startOffset: 0, endOffset: 3, startLine: 1, endLine: 1 },
  viewport: { width: 80, height: 30 },
  createdAt: 1,
};
beforeEach(() => {
  workspace.putAuthorDocument('s', { path: 'doc', kind: 'markdown', content: 'abc\ndef', sourceSha256: 'sha' });
  workspace.focusAuthorDocument('s', 'doc', 0, 'sha');
});
afterEach(() => {
  hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
  hooks.values = [];
  hooks.setters = [];
  workspace.authorWorkspace.reset();
  authorGrid.reset();
  vi.unstubAllGlobals();
});

describe('Author editing controls', () => {
  it.each([
    ['Bold', '**abc**\ndef'],
    ['Heading', '## abc\ndef'],
    ['Link', '[abc](https://)\ndef'],
    ['List', '- abc\ndef'],
  ])('applies %s only to the selected text and invalidates selection', (label, expected) => {
    workspace.setAuthorRegionCandidate('s', region);
    const buttons = nodes(AuthorToolPalette({ sessionId: 's', kind: 'markdown', activeTool: 'select' }));
    buttons.find((node) => node.props['aria-label'] === label)!.props.onClick!(event);
    expect(workspace.authorDocument('s', 'doc')?.content).toBe(expected);
    expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
  });
  it('reports missing and non-text selections without editing', () => {
    for (const candidate of [
      undefined,
      { ...region, anchor: { kind: 'cell' as const, fragmentId: 'f', location: 'A1' } },
    ]) {
      workspace.setAuthorRegionCandidate('s', candidate);
      nodes(AuthorToolPalette({ sessionId: 's', kind: 'markdown', activeTool: 'select' })).find(
        (node) => node.props['aria-label'] === 'Bold',
      )!.props.onClick!(event);
      expect(hooks.setters.at(-1)).toHaveBeenCalledWith('Select text in the document first.');
      expect(workspace.authorDocument('s', 'doc')?.version).toBe(0);
    }
  });
  it('toggles region mode and exposes only supported tools for media', () => {
    for (const activeTool of ['select', 'mark'] as const) {
      const controls = nodes(AuthorToolPalette({ sessionId: 's', kind: 'image', activeTool }));
      expect(controls.some((node) => node.props['aria-label'] === 'Bold')).toBe(false);
      controls.find((node) => node.props['aria-label'] === 'mark region')!.props.onClick!(event);
      expect(workspace.authorSessionWorkspace('s').activeTool).toBe(activeTool === 'mark' ? 'select' : 'mark');
      controls.find((node) => node.props['aria-label'] === 'Comment')!.props.onClick!(event);
      expect(workspace.authorSessionWorkspace('s').activeTool).toBe('mark');
    }
  });
  it('commits a commented draft and removes its region', () => {
    workspace.setAuthorRegionCandidate('s', region);
    hooks.values = ['Keep this'];
    let controls = nodes(AuthorRegionDrafts({ sessionId: 's', workspace: workspace.authorSessionWorkspace('s') }));
    controls.find((node) => node.type === 'textarea')!.props.onChange!({ target: { value: 'Typed' } });
    expect(hooks.setters[0]).toHaveBeenCalledWith('Typed');
    controls.find((node) => node.props.children === 'add region')!.props.onClick!(event);
    expect(workspace.authorSessionWorkspace('s').regions[0]?.comment).toBe('Keep this');
    controls = nodes(AuthorRegionDrafts({ sessionId: 's', workspace: workspace.authorSessionWorkspace('s') }));
    controls.find((node) => node.props['aria-label'] === 'Remove region 1')!.props.onClick!(event);
    expect(workspace.authorSessionWorkspace('s').regions).toEqual([]);
    expect(AuthorRegionDrafts({ sessionId: 's', workspace: workspace.authorSessionWorkspace('s') })).toBeNull();
  });
  it('disables blank region comments and reports a failed commit', () => {
    workspace.setAuthorRegionCandidate('s', region);
    const controls = nodes(AuthorRegionDrafts({ sessionId: 's', workspace: workspace.authorSessionWorkspace('s') }));
    const add = controls.find((node) => node.props.children === 'add region')!;
    expect(add.props.disabled).toBe(true);
    add.props.onClick!(event);
    expect(hooks.setters[1]).toHaveBeenCalledWith('Every Author region requires a comment.');
  });
  it.each(['csv', 'xlsx', 'slides', 'pptx'] as const)(
    'marks and edits native %s fragments with matching grid anchors',
    (kind) => {
      const location = kind === 'csv' ? 'row 1,column 1' : kind === 'xlsx' ? 'Sheet1!A1' : 'slide 1';
      const document = workspace.putAuthorDocument('s', {
        path: 'doc',
        kind,
        sourceSha256: 'sha',
        fragments: [
          { id: 'f', text: 'old', location, kind: 'text-run' },
          { id: 'g', text: 'other', location, kind: 'text-run', readOnly: true },
        ],
      });
      const geometry = updateAuthorGridGeometry('s', {
        documentPath: 'doc',
        revision: 0,
        sourceSha256: 'sha',
        viewport: { width: 80, height: 30 },
      });
      vi.stubGlobal('window', {
        document: { elementFromPoint: () => ({ closest: () => ({ dataset: { authorFragment: 'f' } }) }) },
      });
      const controls = nodes(
        AuthorStructuredView({
          sessionId: 's',
          document,
          displayedRegions: [
            { ordinal: 1, region: { ...region, anchor: { kind: 'cell', fragmentId: 'f', location } } },
            { ordinal: 2, region },
          ],
        }),
      );
      const resolved = resolveAuthorGridNativeAnchor('s', resolveAuthorGridCell('s', 'A1', geometry.geometryToken));
      expect(resolved).toMatchObject({
        quote: 'old',
        anchor: { fragmentId: 'f', kind: kind === 'csv' || kind === 'xlsx' ? 'cell' : 'slide-element' },
      });
      controls.find((node) => node.props.onClick)!.props.onClick!(event);
      expect(workspace.authorSessionWorkspace('s').candidate?.anchor).toEqual(resolved.anchor);
      controls.find((node) => node.type === 'textarea')!.props.onChange!({ target: { value: 'new' } });
      expect(workspace.authorDocument('s', 'doc')?.fragments?.[0]?.text).toBe('new');
    },
  );
  it('does not resolve missing, read-only or non-native slide locations', () => {
    const geometry = updateAuthorGridGeometry('s', {
      documentPath: 'doc',
      revision: 0,
      viewport: { width: 80, height: 30 },
    });
    for (const target of [undefined, 'readonly', 'unknown-slide']) {
      const document = workspace.putAuthorDocument('s', {
        path: 'doc',
        kind: 'slides',
        sourceSha256: 'sha',
        fragments: [
          { id: 'readonly', text: 'locked', location: 'slide 1', kind: 'text-run', readOnly: true },
          { id: 'unknown-slide', text: 'text', location: 'unknown', kind: 'text-run' },
        ],
      });
      vi.stubGlobal('window', {
        document: {
          elementFromPoint: () => (target ? { closest: () => ({ dataset: { authorFragment: target } }) } : null),
        },
      });
      const controls = nodes(AuthorStructuredView({ sessionId: 's', document, displayedRegions: [] }));
      expect(() =>
        resolveAuthorGridNativeAnchor('s', resolveAuthorGridCell('s', 'A1', geometry.geometryToken)),
      ).toThrow();
      if (target === 'unknown-slide') {
        controls.filter((node) => node.props.onClick)[1]!.props.onClick!(event);
        expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
      }
    }
    const empty = workspace.putAuthorDocument('s', { path: 'doc', kind: 'slides' });
    expect(
      nodes(AuthorStructuredView({ sessionId: 's', document: empty, displayedRegions: [] })).some(
        (node) => node.type === 'textarea',
      ),
    ).toBe(false);
  });
});
