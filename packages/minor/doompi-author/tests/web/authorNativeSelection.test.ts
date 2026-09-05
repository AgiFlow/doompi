import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { AuthorTextView } from '../../src/web/AuthorTextView.tsx';
import { AuthorMediaView } from '../../src/web/AuthorMediaView.tsx';
import * as workspace from '../../src/web/authorWorkspaceStore.ts';
import {
  authorGrid,
  resolveAuthorGridCell,
  resolveAuthorGridNativeAnchor,
  updateAuthorGridGeometry,
} from '../../src/web/authorGrid.ts';
import type { AuthorDisplayedRegion } from '../../src/web/authorViewportTypes.ts';
const hooks = vi.hoisted(() => ({
  refs: [] as unknown[],
  setters: [] as ReturnType<typeof vi.fn>[],
  cleanups: [] as (() => void)[],
}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    hooks.setters.push(setter);
    return [initial, setter];
  },
  useRef: (current: unknown) => ({ current: hooks.refs.length ? hooks.refs.shift() : current }),
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
}));
type Range = { from: number; to: number; text: string; startLine: number; endLine: number };
type Pointer = {
  target: unknown;
  clientX: number;
  clientY: number;
  button: number;
  pointerId: number;
  preventDefault: () => void;
  currentTarget: { setPointerCapture: (id: number) => void };
};
type Props = {
  children?: ReactNode;
  'data-testid'?: string;
  onChange?: (value: string) => void;
  onSelect?: (range: Range) => void;
  onPointerDownCapture?: (event: Pointer) => void;
  onPointerUp?: (event: Pointer) => void;
  onPointerCancel?: () => void;
  value?: string;
  text?: string;
};
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
const bounds = { left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 };
function setup(kind: 'text' | 'image' | 'pdf' | 'video' | 'opaque' = 'text') {
  const document = workspace.putAuthorDocument('s', { path: 'doc', kind, sourceSha256: 'sha' });
  workspace.focusAuthorDocument('s', 'doc', 0, 'sha');
  const geometry = updateAuthorGridGeometry('s', {
    documentPath: 'doc',
    revision: 0,
    sourceSha256: 'sha',
    viewport: { width: 800, height: 400 },
  });
  return { document, cell: resolveAuthorGridCell('s', 'A1', geometry.geometryToken) };
}
const range: Range = { from: 0, to: 3, text: 'abc', startLine: 1, endLine: 1 };
const displayed: AuthorDisplayedRegion[] = [
  {
    ordinal: 2,
    region: {
      id: 'r',
      documentPath: 'doc',
      revision: 0,
      comment: 'Edit',
      anchor: { kind: 'text-range', startOffset: 0, endOffset: 3, startLine: 1, endLine: 1 },
      viewport: { width: 800, height: 400 },
      createdAt: 1,
    },
  },
];
afterEach(() => {
  hooks.cleanups.splice(0).forEach((cleanup) => cleanup());
  hooks.refs = [];
  hooks.setters = [];
  workspace.authorWorkspace.reset();
  authorGrid.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Author text selection integration', () => {
  it('maps visible text grid cells and editor selection to current native anchors', () => {
    const { document, cell } = setup();
    const controller = { resolveViewportRegion: vi.fn(() => range), setMarkedRanges: vi.fn() };
    hooks.refs = [{ getBoundingClientRect: () => bounds }, controller];
    const controls = nodes(
      AuthorTextView({
        sessionId: 's',
        document,
        preview: false,
        displayedRegions: [
          ...displayed,
          {
            ordinal: 3,
            region: { ...displayed[0]!.region, anchor: { kind: 'cell', fragmentId: 'f', location: 'A1' } },
          },
        ],
      }),
    );
    expect(resolveAuthorGridNativeAnchor('s', cell)).toMatchObject({
      quote: 'abc',
      anchor: { kind: 'text-range', startOffset: 0, endOffset: 3 },
    });
    expect(controller.resolveViewportRegion).toHaveBeenCalledWith({ left: 0, top: 0, right: 100, bottom: 50 });
    expect(controller.setMarkedRanges).toHaveBeenCalledWith([{ from: 0, to: 3, label: '2' }]);
    const editor = controls.find((node) => node.props['data-testid'] === 'author-editor')!;
    expect(editor.props.value).toBe('');
    editor.props.onSelect!(range);
    expect(workspace.authorSessionWorkspace('s').candidate).toMatchObject({
      quote: 'abc',
      viewport: { width: 800, height: 400 },
    });
    editor.props.onChange!('new');
    expect(workspace.authorDocument('s', 'doc')?.content).toBe('new');
  });
  it('rejects preview, unavailable editors and collapsed ranges as mutation authority', () => {
    const { document, cell } = setup();
    for (const resolved of [null, { ...range, to: 0 }]) {
      hooks.refs = [null, { resolveViewportRegion: () => resolved, setMarkedRanges: vi.fn() }];
      nodes(AuthorTextView({ sessionId: 's', document, preview: false, displayedRegions: [] }));
      expect(() => resolveAuthorGridNativeAnchor('s', cell)).toThrow();
    }
    hooks.refs = [null, null];
    const controls = nodes(AuthorTextView({ sessionId: 's', document, preview: true, displayedRegions: [] }));
    expect(controls.some((node) => node.props.text === '')).toBe(true);
    expect(() => resolveAuthorGridNativeAnchor('s', cell)).toThrow();
    hooks.refs = [null, null];
    nodes(AuthorTextView({ sessionId: 's', document, preview: false, displayedRegions: [] }));
    expect(() => resolveAuthorGridNativeAnchor('s', cell)).toThrow();
  });
  it('ignores selection when its host, document or nonempty range is unavailable', () => {
    const { document } = setup();
    for (const host of [null, { getBoundingClientRect: () => bounds }]) {
      hooks.refs = [host, null];
      const editor = nodes(AuthorTextView({ sessionId: 's', document, preview: false, displayedRegions: [] })).find(
        (node) => node.props.onSelect,
      )!;
      editor.props.onSelect!({ ...range, to: 0 });
      expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
      if (!host) {
        editor.props.onSelect!(range);
        expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
      }
      workspace.dropAuthorSession('s');
      editor.props.onSelect!(range);
      expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
    }
  });
});

class ImageElement {
  naturalWidth = 1600;
  naturalHeight = 800;
  getBoundingClientRect() {
    return bounds;
  }
}
class VideoElement {
  getBoundingClientRect() {
    return bounds;
  }
}
class CanvasElement {
  getBoundingClientRect() {
    return bounds;
  }
}
function mediaFixture(
  kind: 'image' | 'video' | 'pdf' | 'opaque' = 'image',
  options: { image?: ImageElement | null; video?: unknown; pdf?: unknown; blob?: Blob | null; context?: boolean } = {},
) {
  const { document, cell } = setup(kind);
  vi.stubGlobal('HTMLImageElement', ImageElement);
  vi.stubGlobal('HTMLVideoElement', VideoElement);
  vi.stubGlobal('HTMLCanvasElement', CanvasElement);
  const drawImage = vi.fn();
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => (options.context === false ? null : { drawImage }),
      toBlob: (callback: (blob: Blob | null) => void) =>
        callback(options.blob === undefined ? new Blob(['image']) : options.blob),
    }),
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:selection');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const image = options.image === undefined ? new ImageElement() : options.image;
  hooks.refs = [null, image, options.video ?? null, options.pdf ?? null, undefined];
  const root = AuthorMediaView({
    sessionId: 's',
    document,
    activeTool: 'mark',
    displayedRegions: displayed,
  }) as ReactElement<Props>;
  const pointer = (target: unknown, x: number, y: number): Pointer => ({
    target,
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
    preventDefault: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn() },
  });
  async function drag(target: unknown = image, end = { x: 400, y: 200 }) {
    root.props.onPointerDownCapture!(pointer(target, 0, 0));
    root.props.onPointerUp!(pointer(target, end.x, end.y));
    await Promise.resolve();
    await Promise.resolve();
  }
  return { root, image, cell, document, pointer, drag, drawImage };
}
describe('Author media selection integration', () => {
  it('resolves image cells and captures source-normalized rectangles', async () => {
    const fixture = mediaFixture();
    expect(resolveAuthorGridNativeAnchor('s', fixture.cell)).toMatchObject({
      anchor: {
        kind: 'image-rect',
        rect: { x: 0, y: 0, width: 0.125, height: 0.125 },
        naturalWidth: 1600,
        naturalHeight: 800,
      },
    });
    await fixture.drag();
    expect(workspace.authorSessionWorkspace('s').candidate).toMatchObject({
      anchor: { kind: 'image-rect', rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      thumbnailUrl: 'blob:selection',
    });
    expect(fixture.drawImage).toHaveBeenCalledWith(fixture.image, 0, 0, 1600, 800);
  });
  it('does not resolve image coordinates before load or outside the rendered image', () => {
    for (const image of [
      null,
      Object.assign(new ImageElement(), { naturalWidth: 0 }),
      Object.assign(new ImageElement(), { naturalHeight: 0 }),
      Object.assign(new ImageElement(), { getBoundingClientRect: () => ({ ...bounds, left: 900 }) }),
      Object.assign(new ImageElement(), { getBoundingClientRect: () => ({ ...bounds, top: 900 }) }),
    ]) {
      const fixture = mediaFixture('image', { image });
      expect(() => resolveAuthorGridNativeAnchor('s', fixture.cell)).toThrow();
    }
  });
  it('ignores non-primary, non-media, cancelled and empty drags', async () => {
    const { root, image, pointer, drag } = mediaFixture();
    root.props.onPointerUp!(pointer(image, 400, 200));
    root.props.onPointerDownCapture!({ ...pointer(image, 0, 0), button: 1 });
    root.props.onPointerUp!(pointer(image, 400, 200));
    await drag({});
    await drag(image, { x: 0, y: 0 });
    root.props.onPointerDownCapture!(pointer(image, 0, 0));
    root.props.onPointerCancel!();
    root.props.onPointerUp!(pointer(image, 400, 200));
    expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
    hooks.refs = [null, image, null, null, undefined];
    const select = AuthorMediaView({
      sessionId: 's',
      document: workspace.authorDocument('s', 'doc')!,
      activeTool: 'select',
      displayedRegions: [],
    }) as ReactElement<Props>;
    select.props.onPointerDownCapture!(pointer(image, 0, 0));
    expect(pointer(image, 0, 0).preventDefault).not.toHaveBeenCalled();
  });
  it('reports unloaded images, canvas failures and missing capture bytes', async () => {
    for (const options of [
      { image: Object.assign(new ImageElement(), { naturalWidth: 0 }) },
      { image: Object.assign(new ImageElement(), { naturalHeight: 0 }) },
      { context: false },
      { blob: null },
    ]) {
      const fixture = mediaFixture('image', options);
      await fixture.drag();
      expect(hooks.setters.at(-1)).toHaveBeenCalledWith(
        expect.stringMatching(/not ready|unavailable|Unable to capture/),
      );
    }
    expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
  });
  it('captures native video timestamps and PDF page numbers', async () => {
    const video = mediaFixture('video', {
      video: { captureFrame: async () => ({ timeSeconds: 12, width: 1920, height: 1080, blob: new Blob(['frame']) }) },
    });
    await video.drag(new VideoElement());
    expect(workspace.authorSessionWorkspace('s').candidate?.anchor).toMatchObject({
      kind: 'video-time-rect',
      timeSeconds: 12,
      intrinsicWidth: 1920,
    });
    const pdf = mediaFixture('pdf', {
      pdf: { getState: () => ({ sourceWidth: 600, page: 2 }), capturePage: async () => new Blob(['page']) },
    });
    await pdf.drag(new CanvasElement());
    expect(workspace.authorSessionWorkspace('s').candidate?.anchor).toMatchObject({ kind: 'pdf-page-rect', page: 2 });
    expect(() => resolveAuthorGridNativeAnchor('s', pdf.cell)).toThrow();
  });
  it('rejects unavailable native PDF/video controllers', async () => {
    const video = mediaFixture('video');
    await video.drag(new VideoElement());
    expect(hooks.setters.at(-1)).toHaveBeenCalledWith('Video frame is not ready.');
    const pdf = mediaFixture('pdf');
    await pdf.drag(new CanvasElement());
    expect(hooks.setters.at(-1)).toHaveBeenCalledWith('PDF page is not ready.');
    mediaFixture('opaque');
  });
  it('discards captures when focus moves before or during asynchronous capture', async () => {
    let fixture = mediaFixture();
    workspace.focusAuthorDocument('s', 'other', 0);
    await fixture.drag();
    expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
    fixture = mediaFixture();
    workspace.dropAuthorSession('s');
    await fixture.drag();
    expect(workspace.authorSessionWorkspace('s').candidate).toBeUndefined();
    fixture = mediaFixture();
    fixture.root.props.onPointerDownCapture!(fixture.pointer(fixture.image, 0, 0));
    fixture.root.props.onPointerUp!(fixture.pointer(fixture.image, 400, 200));
    workspace.focusAuthorDocument('s', 'other', 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
