import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  exportPreviewImage: vi.fn(),
  buildPreview: vi.fn(),
  disposePreview: vi.fn(),
  storyMetadata: vi.fn(),
}));

const hooks = vi.hoisted(() => ({
  state: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as { deps?: readonly unknown[]; cleanup?: () => void }[],
  stateIndex: 0,
  refIndex: 0,
  effectIndex: 0,
  pending: [] as (() => void)[],
}));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.state)) hooks.state[index] = initial;
    return [hooks.state[index], (value: unknown) => (hooks.state[index] = value)];
  },
  useRef: (initial: unknown) => {
    const index = hooks.refIndex++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index];
  },
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = hooks.effectIndex++;
    const previous = hooks.effects[index];
    const changed =
      previous === undefined || deps === undefined || previous.deps?.some((value, item) => value !== deps[item]);
    if (!changed) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      hooks.effects[index] = { deps, cleanup: effect() ?? undefined };
    });
  },
}));

vi.mock('../../src/extensions/workspaces/sessions/(frontend)/_lib/previewApi', () => ({
  buildPreview: api.buildPreview,
  disposePreview: api.disposePreview,
  exportPreviewImage: api.exportPreviewImage,
  storyMetadata: api.storyMetadata,
}));

import { StoryPreviewPanel } from '../../src/extensions/workspaces/sessions/(frontend)/_components/StoryPreviewPanel';

function render(
  activeTool: 'select' | 'mark',
  props: Partial<Parameters<typeof StoryPreviewPanel>[0]> = {},
): ReturnType<typeof StoryPreviewPanel> {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  hooks.effectIndex = 0;
  const tree = StoryPreviewPanel({
    sessionId: 'session',
    activeTool,
    onAnnotationCandidate: vi.fn(),
    ...props,
  } as unknown as Parameters<typeof StoryPreviewPanel>[0]);
  const pending = hooks.pending.splice(0);
  pending.forEach((effect) => effect());
  return tree;
}

const tick = async () => await new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  hooks.state = [];
  hooks.refs = [];
  hooks.effects = [];
  hooks.pending = [];
  vi.clearAllMocks();
});

describe('StoryPreviewPanel annotation export', () => {
  it('retries a failed automatic export while the annotation tool remains active', async () => {
    api.exportPreviewImage.mockResolvedValueOnce({ ok: false, error: 'render failed' }).mockResolvedValueOnce({
      ok: true,
      image: {
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
        captureId: 'capture',
        width: 320,
        height: 180,
        storyPath: 'Button.stories.tsx',
        storyExport: 'Primary',
        buildRevision: 'sha',
        sources: [],
      },
    });
    render('select');
    const preview = { handle: 'preview', html: '', storyPath: 'Button.stories.tsx', storyExport: 'Primary' };
    const request = { appPath: '.', storyPath: 'Button.stories.tsx', storyExport: 'Primary', darkMode: false };
    hooks.state[5] = preview;
    hooks.state[6] = request;
    hooks.refs[2]!.current = preview;
    hooks.refs[3]!.current = request;

    render('mark');
    await tick();
    expect(api.exportPreviewImage).toHaveBeenCalledOnce();

    render('mark');
    await tick();
    expect(api.exportPreviewImage).toHaveBeenCalledTimes(2);
    expect(hooks.state[7]).toMatchObject({ captureId: 'capture' });
  });
});

const seed = { appPath: 'apps/web', storyPath: 'packages/ui/Button.stories.tsx', storyExport: 'Primary' };
const metadata = {
  ok: true,
  metadata: { ...seed, exports: [{ exportName: 'Playground' }, { exportName: 'Primary' }] },
};
const snapshotImage = {
  data: 'aW1hZ2U=',
  mimeType: 'image/png',
  captureId: 'snapshot',
  width: 320,
  height: 180,
  storyPath: seed.storyPath,
  storyExport: seed.storyExport,
  sourceSha256: 'sha',
};

describe('selected story previews', () => {
  it('preserves the explicit consuming project and exact export', async () => {
    api.storyMetadata.mockResolvedValue(metadata);
    api.buildPreview.mockResolvedValue({
      ok: true,
      preview: { ...seed, handle: 'selected', html: '<html/>', sourceSha256: 'sha' },
    });
    render('select', { seed });
    expect(api.storyMetadata).toHaveBeenCalledWith('session', { storyPath: seed.storyPath, appPath: seed.appPath });
    expect(api.buildPreview).not.toHaveBeenCalled();
    await tick();
    render('select', { seed });
    await tick();
    expect(api.buildPreview).toHaveBeenCalledWith('session', { ...seed, darkMode: false });
    expect(hooks.state[5]).toMatchObject({ handle: 'selected', storyExport: 'Primary' });
  });

  it('rejects a vanished requested export instead of silently building Playground', async () => {
    api.storyMetadata.mockResolvedValue({
      ...metadata,
      metadata: { ...metadata.metadata, exports: [{ exportName: 'Playground' }] },
    });
    render('select', { seed });
    await tick();
    render('select', { seed });
    expect(api.buildPreview).not.toHaveBeenCalled();
    expect(hooks.state[2]).toBe('');
  });

  it('uses the image API without an HTML build for snapshot configurations', async () => {
    const snapshotSeed = { ...seed, snapshot: true };
    api.storyMetadata.mockResolvedValue(metadata);
    api.exportPreviewImage.mockResolvedValue({ ok: true, image: snapshotImage });
    render('select', { seed: snapshotSeed });
    await tick();
    render('select', { seed: snapshotSeed });
    await tick();
    expect(api.buildPreview).not.toHaveBeenCalled();
    expect(api.exportPreviewImage).toHaveBeenCalledWith('session', { ...seed, darkMode: false });
    expect(hooks.state[16]).toMatchObject({ captureId: 'snapshot' });
  });

  it('disposes a successful build that arrives after the panel closes', async () => {
    let complete: ((value: unknown) => void) | undefined;
    api.storyMetadata.mockResolvedValue(metadata);
    api.buildPreview.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    render('select', { seed });
    await tick();
    render('select', { seed });
    hooks.effects.forEach((effect) => effect.cleanup?.());
    complete?.({ ok: true, preview: { handle: 'late', html: '', ...seed } });
    await tick();
    expect(api.disposePreview).toHaveBeenCalledWith('session', 'late');
    expect(hooks.state[5]).toBeUndefined();
  });
});
