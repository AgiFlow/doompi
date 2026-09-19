import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  exportPreviewImage: vi.fn(),
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
  buildPreview: vi.fn(),
  disposePreview: vi.fn(),
  exportPreviewImage: api.exportPreviewImage,
  storyMetadata: vi.fn(),
}));

import { StoryPreviewPanel } from '../../src/extensions/workspaces/sessions/(frontend)/_components/StoryPreviewPanel';

function render(activeTool: 'select' | 'mark'): void {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  hooks.effectIndex = 0;
  StoryPreviewPanel({
    sessionId: 'session',
    activeTool,
    onAnnotationCandidate: vi.fn(),
  });
  const pending = hooks.pending.splice(0);
  pending.forEach((effect) => effect());
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
