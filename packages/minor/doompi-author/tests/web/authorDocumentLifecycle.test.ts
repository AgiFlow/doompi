import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode, type ReactElement } from 'react';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { AuthorDocumentPanel, authorFileLinks, authorFileTab } from '../../src/web/AuthorDocumentPanel.tsx';
import { AuthorTextView } from '../../src/web/AuthorTextView.tsx';
import { AuthorMediaView } from '../../src/web/AuthorMediaView.tsx';
import { AuthorStructuredView } from '../../src/web/AuthorStructuredView.tsx';
import * as workspace from '../../src/web/authorWorkspaceStore.ts';
import { loadAuthorDocument, saveAuthorDocument } from '../../src/web/authorFiles.ts';
import { focusAuthorViewport } from '../../src/web/authorBrowserBridge.ts';
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  setters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    hooks.setters.push(setter);
    return [hooks.values.length ? hooks.values.shift() : initial, setter];
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
vi.mock('@tanstack/react-store', () => ({
  useStore: (store: { state: unknown }, select: (state: unknown) => unknown) => select(store.state),
}));
vi.mock('../../src/web/authorFiles.ts', () => ({ loadAuthorDocument: vi.fn(), saveAuthorDocument: vi.fn() }));
vi.mock('../../src/web/authorBrowserBridge.ts', () => ({ focusAuthorViewport: vi.fn(async () => vi.fn()) }));
type Props = {
  children?: ReactNode;
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
function render(sessionId: string | null = 's', statuses: Record<string, string> = {}) {
  const element = AuthorDocumentPanel({
    sessionId,
    path: 'doc',
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
  hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
  hooks.effects = [];
  hooks.values = [];
  hooks.setters = [];
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
    effects();
    await settle();
    expect(workspace.authorDocument('s', 'doc')?.content).toBe('loaded');
    expect(hooks.setters[1]).toHaveBeenCalledWith('loading');
    render();
    effects();
    await settle();
    expect(workspace.authorSessionWorkspace('s').focusedDocument).toMatchObject({ path: 'doc', sourceSha256: 'sha' });
    expect(focusAuthorViewport).toHaveBeenCalledWith('s', expect.any(Array));
    hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
    expect(workspace.authorSessionWorkspace('s').focusedDocument).toBeUndefined();
  });
  it('does not load documents without a session', () => {
    render(null);
    effects();
    expect(loadAuthorDocument).not.toHaveBeenCalled();
  });
  it('surfaces load failures without populating the workspace', async () => {
    vi.mocked(loadAuthorDocument).mockRejectedValueOnce(new Error('Read denied'));
    render();
    effects();
    await settle();
    expect(hooks.setters[1]).toHaveBeenCalledWith('Read denied');
    expect(workspace.authorDocument('s', 'doc')).toBeUndefined();
    hooks.values = [true, 'Read denied'];
    expect(render().some((node) => node.props.children === 'Read denied')).toBe(true);
  });
  it('ignores late loading results after teardown', async () => {
    vi.mocked(loadAuthorDocument).mockResolvedValueOnce({ path: 'doc', kind: 'text', content: 'late' });
    render();
    effects();
    hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
    await settle();
    expect(workspace.authorDocument('s', 'doc')).toBeUndefined();
    vi.mocked(loadAuthorDocument).mockRejectedValueOnce(new Error('aborted'));
    render();
    effects();
    hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
    await settle();
    expect(hooks.setters.at(-1)).not.toHaveBeenCalledWith('aborted');
  });
  it('releases a viewport whose registration resolves after teardown', async () => {
    workspace.putAuthorDocument('s', { path: 'doc', kind: 'text' });
    const release = vi.fn();
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
  it('makes markdown editable during marking or autonomous voice and toggles preview explicitly', () => {
    workspace.putAuthorDocument('s', { path: 'doc', title: 'Title', kind: 'markdown', content: 'abc' });
    let controls = render();
    expect(controls.find((node) => node.type === AuthorTextView)?.props.preview).toBe(true);
    controls.find((node) => node.props['data-testid'] === 'author-markdown-toggle')!.props.onClick!();
    expect(hooks.setters[0]).toHaveBeenCalledWith(false);
    hooks.values = [false];
    controls = render();
    expect(controls.find((node) => node.type === AuthorTextView)?.props.preview).toBe(false);
    workspace.setAuthorToolMode('s', 'mark');
    controls = render();
    expect(controls.find((node) => node.type === AuthorTextView)?.props.preview).toBe(false);
    workspace.setAuthorToolMode('s', 'select');
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
    expect(hooks.setters.at(-1)).toHaveBeenCalledWith('Conflict');
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
    expect(authorFileLinks.openPath!('s', './')).toBeUndefined();
    expect(authorFileLinks.openPath!('s', 'new.md')?.label).toBe('new.md');
    const panel = authorFileTab('dir/doc.md').panel as (props: WebPluginSlotProps) => ReactNode;
    expect(panel({ sessionId: 's' } as WebPluginSlotProps)).toBeTruthy();
    unsubscribe();
  });
});
