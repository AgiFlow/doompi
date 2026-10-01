import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthorDocumentPanel,
  authorFileLinks,
  authorFileTab,
} from '../../src/extensions/workspaces/sessions/(frontend)/_components/AuthorDocumentPanel';
import { AuthorMediaView } from '../../src/extensions/workspaces/sessions/(frontend)/_components/AuthorMediaView';
import { AuthorStructuredView } from '../../src/extensions/workspaces/sessions/(frontend)/_components/AuthorStructuredView';
import { AuthorTextView } from '../../src/extensions/workspaces/sessions/(frontend)/_components/AuthorTextView';
import { focusAuthorViewport } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorBrowserBridge';
import { canvasPaths } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorCanvasState';
import {
  loadAuthorDocument,
  saveAuthorDocument,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorFiles';
import * as workspace from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorWorkspaceStore';
import { AuthorFeedbackControls } from '../../src/extensions/workspaces/sessions/(frontend)/dock/_components/AuthorFeedbackControls';
import { AuthorPanel } from '../../src/extensions/workspaces/sessions/(frontend)/dock/_components/AuthorPanel';
import { AuthorRequestLog } from '../../src/extensions/workspaces/sessions/(frontend)/dock/_components/AuthorRequestLog';
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  setters: [] as ReturnType<typeof vi.fn>[],
  statusSetters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    hooks.setters.push(setter);
    if (initial === undefined) hooks.statusSetters.push(setter);
    return [hooks.values.length ? hooks.values.shift() : initial, setter];
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
vi.mock('@tanstack/react-store', () => ({
  useStore: (store: { state: unknown }, select: (state: unknown) => unknown) => select(store.state),
}));
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_lib/authorFiles', () => ({
  loadAuthorDocument: vi.fn(),
  saveAuthorDocument: vi.fn(),
}));
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_lib/authorBrowserBridge', () => ({
  focusAuthorViewport: vi.fn(async () => vi.fn()),
  openAuthorCanvas: vi.fn(async () => undefined),
  dropAuthorViewportSession: vi.fn(),
}));
vi.mock('../../generated/client', () => ({
  api: {
    session: () => ({
      documentsOpen: vi.fn(async () => ({ ok: true, data: { path: 'doc', alias: 'doc' } })),
      bridgeClose: vi.fn(async () => ({ ok: true })),
    }),
  },
}));
type Props = {
  children?: ReactNode;
  requests?: readonly unknown[];
  drafts?: workspace.AuthorDocumentAnnotationCollection;
  'data-testid'?: string;
  onClick?: () => void;
  preview?: boolean;
  disabled?: boolean;
};
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function render(sessionId: string | null = 's', statuses: Record<string, string> = {}, path = 'doc') {
  const element = AuthorDocumentPanel({
    sessionId,
    path,
    statuses,
    activeMinorModes: ['author'],
  } as unknown as WebPluginSlotProps & { path: string });
  return nodes((element.type as (props: unknown) => ReactNode)(element.props));
}
function effects() {
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  }
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
afterEach(() => {
  authorFileTab('doc').onClose?.('s');
  hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
  hooks.effects = [];
  hooks.values = [];
  hooks.setters = [];
  hooks.statusSetters = [];
  workspace.authorWorkspace.reset();
  vi.clearAllMocks();
});

describe('Author document lifecycle', () => {
  it('loads a document, claims focus and releases it on unmount', async () => {
    vi.mocked(loadAuthorDocument).mockResolvedValueOnce({
      path: 'doc',
      kind: 'text',
      content: 'loaded',
      sourceSha256: 'sha',
    });
    expect(render().some((node) => node.props.children === 'Loading document...')).toBe(true);
    authorFileTab('doc').onOpen?.('s');
    await settle();
    expect(workspace.authorDocument('s', 'doc')?.content).toBe('loaded');
    render();
    effects();
    await settle();
    expect(workspace.authorSessionWorkspace('s').focusedDocument).toMatchObject({ path: 'doc' });
    expect(focusAuthorViewport).toHaveBeenCalledWith('s', expect.any(Array), 'doc');
    hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(workspace.authorSessionWorkspace('s').focusedDocument).toBeUndefined();
  });
  it('uses the server-canonical path for a provisional link without creating a second draft', async () => {
    vi.mocked(loadAuthorDocument).mockResolvedValueOnce({ path: 'doc', kind: 'text', content: 'loaded' });
    const tab = authorFileTab('link');
    tab.onOpen?.('s');
    await settle();
    expect(loadAuthorDocument).toHaveBeenCalledWith('s', 'doc', expect.any(AbortSignal));
    expect(workspace.authorDocument('s', 'link')).toBeUndefined();
    expect(workspace.authorDocument('s', 'doc')?.content).toBe('loaded');
    expect(render('s', {}, 'link').some((node) => node.props['data-testid'] === 'author-document')).toBe(true);
    tab.onClose?.('s');
  });
  it('does not load documents without a session', () => {
    render(null);
    effects();
    expect(loadAuthorDocument).not.toHaveBeenCalled();
  });
  it('surfaces load failures without populating the workspace', async () => {
    vi.mocked(loadAuthorDocument).mockRejectedValueOnce(new Error('Read denied'));
    authorFileTab('doc').onOpen?.('s');
    await settle();
    expect(workspace.authorDocument('s', 'doc')).toBeUndefined();
    expect(loadAuthorDocument).toHaveBeenCalledOnce();
    expect(render().some((node) => node.props.children === 'Read denied')).toBe(true);
  });
  it('ignores late loading results after teardown', async () => {
    vi.mocked(loadAuthorDocument).mockResolvedValueOnce({ path: 'doc', kind: 'text', content: 'late' });
    const tab = authorFileTab('doc');
    tab.onOpen?.('s');
    tab.onClose?.('s');
    await settle();
    expect(workspace.authorDocument('s', 'doc')).toBeUndefined();
  });
  it('releases a viewport whose registration resolves after teardown', async () => {
    workspace.putAuthorDocument('s', { path: 'doc', kind: 'text' });
    const release = vi.fn();
    authorFileTab('doc').onOpen?.('s');
    await settle();
    vi.mocked(focusAuthorViewport).mockResolvedValueOnce(release);
    render();
    effects();
    hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
    await settle();
    expect(release).toHaveBeenCalledOnce();
  });
  it.each(['text', 'markdown', 'csv', 'image'] as const)('routes %s documents to their native view', (kind) => {
    workspace.putAuthorDocument('s', { path: 'doc', kind, ...(kind === 'csv' ? { structuredFormat: 'csv' } : {}) });
    const controls = render();
    expect(
      controls.some(
        (node) =>
          node.type ===
          (kind === 'text' || kind === 'markdown'
            ? AuthorTextView
            : kind === 'csv'
              ? AuthorStructuredView
              : AuthorMediaView),
      ),
    ).toBe(true);
    expect(controls.find((node) => node.props['data-testid'] === 'author-save')?.props.disabled).toBe(true);
  });
  it('claims focus before load and excludes another document completion from the dock', () => {
    workspace.putAuthorDocument('s', { path: 'a.png', kind: 'image' });
    workspace.focusAuthorDocument('s', 'a.png');
    workspace.putAuthorRequest('s', {
      id: 'a-done',
      documentPath: 'a.png',
      requestText: 'Fix A',
      status: 'COMPLETE',
      regions: [
        {
          id: 'r',
          documentPath: 'a.png',
          revision: 0,
          comment: 'Fix A',
          anchor: { kind: 'image-point', point: { x: 0.1, y: 0.2 }, naturalWidth: 10, naturalHeight: 10 },
          viewport: { width: 10, height: 10 },
          createdAt: 1,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
    });
    render('s', {}, 'b.png');
    effects();
    expect(workspace.authorDocument('s', 'b.png')).toBeUndefined();
    expect(workspace.authorSessionWorkspace('s').focusedDocument?.path).toBe('b.png');
    const dock = nodes(
      AuthorPanel({
        sessionId: 's',
        activeMinorModes: ['author'],
        renderSlot: () => null,
      } as unknown as WebPluginSlotProps),
    );
    expect(dock.find((node) => node.type === AuthorRequestLog)?.props.requests).toEqual([]);
  });
  it('resets the canonical document tool when a provisional tab closes', () => {
    const tab = authorFileTab('provisional.png');
    canvasPaths.setState(() => ({ 's\nprovisional.png': 'canonical.png' }));
    workspace.setAuthorToolMode('s', 'canonical.png', 'draw');
    tab.onClose?.('s');
    expect(workspace.authorToolMode('s', 'canonical.png')).toBe('select');
    canvasPaths.setState(() => ({}));
  });
  it("never shows another document's annotations while focus hands over", () => {
    for (const path of ['a.png', 'b.png'])
      workspace.putAuthorDocument('s', { path, kind: 'image', sourceSha256: 'sha' });
    workspace.focusAuthorDocument('s', 'a.png');
    workspace.setAuthorToolMode('s', 'a.png', 'draw');
    workspace.addAuthorRegion('s', {
      id: 'draft-a',
      documentPath: 'a.png',
      revision: 0,
      sourceSha256: 'sha',
      comment: 'Fix A',
      mode: 'region',
      anchor: {
        kind: 'image-rect',
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        naturalWidth: 10,
        naturalHeight: 10,
      },
      viewport: { width: 100, height: 100 },
      createdAt: 1,
    });
    const b = render('s', {}, 'b.png');
    expect(b.find((node) => node.type === AuthorMediaView)?.props).toMatchObject({
      displayedRegions: [],
      activeTool: 'select',
      pendingCandidate: false,
    });
    expect(b.find((node) => node.type === AuthorFeedbackControls)?.props.drafts).toMatchObject({ annotations: [] });
    const a = render('s', {}, 'a.png');
    expect(a.find((node) => node.type === AuthorMediaView)?.props).toMatchObject({
      displayedRegions: [{ ordinal: 1, region: { id: 'draft-a' } }],
      activeTool: 'draw',
    });
    expect(a.some((node) => node.type === AuthorFeedbackControls)).toBe(true);
  });
  it('makes markdown editable during marking or autonomous voice and toggles preview explicitly', () => {
    workspace.putAuthorDocument('s', { path: 'doc', title: 'Title', kind: 'markdown', content: 'abc' });
    let controls = render();
    expect(controls.find((node) => node.type === AuthorTextView)?.props.preview).toBe(true);
    controls.find((node) => node.props['data-testid'] === 'author-markdown-toggle')!.props.onClick!();
    expect(hooks.setters[0]).toHaveBeenCalledWith(false);
    hooks.values = [false];
    controls = render();
    expect(controls.find((node) => node.type === AuthorTextView)?.props.preview).toBe(false);
    workspace.setAuthorToolMode('s', 'doc', 'mark');
    controls = render();
    expect(controls.find((node) => node.type === AuthorTextView)?.props.preview).toBe(false);
    workspace.setAuthorToolMode('s', 'doc', 'select');
    controls = render('s', { 'doom-voice': 'voice auto: listening' });
    expect(controls.find((node) => node.type === AuthorTextView)?.props.preview).toBe(false);
  });
  it('saves edits and clears the in-flight fence after success or failure', async () => {
    workspace.putAuthorDocument('s', { path: 'doc', kind: 'text', content: 'old', sourceSha256: 'sha' });
    workspace.reviseAuthorDocument('s', 'doc', 'new');
    vi.mocked(saveAuthorDocument).mockResolvedValueOnce('saved-sha');
    let controls = render();
    expect(controls.find((node) => node.props['data-testid'] === 'author-save')?.props.disabled).toBe(false);
    controls.find((node) => node.props['data-testid'] === 'author-save')!.props.onClick!();
    expect(workspace.authorDocument('s', 'doc')?.savingVersion).toBe(1);
    await settle();
    expect(workspace.authorDocument('s', 'doc')).toMatchObject({
      savedVersion: 1,
      sourceSha256: 'saved-sha',
      savingVersion: undefined,
    });
    expect(hooks.setters[1]).toHaveBeenCalledWith('saved');
    workspace.reviseAuthorDocument('s', 'doc', 'newer');
    vi.mocked(saveAuthorDocument).mockRejectedValueOnce(new Error('Conflict'));
    controls = render();
    controls.find((node) => node.props['data-testid'] === 'author-save')!.props.onClick!();
    await settle();
    expect(workspace.authorDocument('s', 'doc')).toMatchObject({
      savedVersion: 1,
      version: 2,
      savingVersion: undefined,
    });
    expect(hooks.statusSetters.at(-1)).toHaveBeenCalledWith('Conflict');
    workspace.requestAuthorSave('s', 'doc');
    hooks.values = [true, 'saving'];
    expect(render().find((node) => node.props['data-testid'] === 'author-save')?.props.disabled).toBe(true);
  });
  it('resolves only loaded session files and normalizes line links and explicit opens', () => {
    const listener = vi.fn();
    const unsubscribe = authorFileLinks.subscribe(listener);
    workspace.putAuthorDocument('s', { path: 'dir/doc.md', kind: 'markdown' });
    workspace.putAuthorDocument('other', { path: 'other.md', kind: 'markdown' });
    expect(listener).toHaveBeenCalled();
    expect(authorFileLinks.fingerprint(null)).toBe('');
    expect(authorFileLinks.fingerprint('s')).toBe('s\ndir/doc.md');
    expect(authorFileLinks.resolve(null, 'dir/doc.md')).toBeUndefined();
    expect(authorFileLinks.resolve('s', 'missing')).toBeUndefined();
    expect(authorFileLinks.resolve('s', 'dir/doc.md:2:4')?.label).toBe('doc.md');
    expect(authorFileLinks.openPath!(null, 'doc')).toBeUndefined();
    expect(authorFileLinks.openPath!('s', './.')).toBeUndefined();
    expect(authorFileLinks.openPath!('s', 'new.md')?.label).toBe('new.md');
    const panel = authorFileTab('dir/doc.md').panel as (props: WebPluginSlotProps) => ReactNode;
    expect(panel({ sessionId: 's' } as WebPluginSlotProps)).toBeTruthy();
    unsubscribe();
  });
});
