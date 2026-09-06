import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorMediaPreview } from '../../src/web/components/AuthorMediaPreview.tsx';
import { loadAuthorMedia } from '../../src/web/api/authorMedia.ts';

const hooks = vi.hoisted(() => ({
  value: undefined as undefined | { source: string; url?: string; error?: string },
  set: vi.fn(),
  cleanup: undefined as undefined | (() => void),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: () => [hooks.value, hooks.set],
  useEffect: (effect: () => () => void) => {
    hooks.cleanup = effect();
  },
}));
vi.mock('../../src/web/api/authorMedia.ts', () => ({ loadAuthorMedia: vi.fn() }));
afterEach(() => {
  hooks.cleanup?.();
  hooks.cleanup = undefined;
  hooks.value = undefined;
  vi.clearAllMocks();
});
const source = '/api/sessions/s/file?path=clip.mp4';
describe('read-only Author media', () => {
  it('loads and releases media without enabling Author mode', async () => {
    const dispose = vi.fn();
    vi.mocked(loadAuthorMedia).mockResolvedValue({ url: 'blob:clip', dispose });
    AuthorMediaPreview({ sessionId: 's', path: 'clip.mp4' });
    await vi.waitFor(() => expect(hooks.set).toHaveBeenCalledWith({ source, url: 'blob:clip' }));
    hooks.cleanup?.();
    hooks.cleanup = undefined;
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('disposes a late response after closing', async () => {
    let resolve!: (asset: Awaited<ReturnType<typeof loadAuthorMedia>>) => void;
    vi.mocked(loadAuthorMedia).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const dispose = vi.fn();
    AuthorMediaPreview({ sessionId: 's', path: 'clip.mp4' });
    hooks.cleanup?.();
    resolve({ url: 'blob:late', dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(hooks.set).not.toHaveBeenCalled();
  });
  it.each([new Error('denied'), 'denied'])('reports failed delivery', async (error) => {
    vi.mocked(loadAuthorMedia).mockRejectedValue(error);
    AuthorMediaPreview({ sessionId: 's', path: 'clip.mp4' });
    await vi.waitFor(() => expect(hooks.set).toHaveBeenCalledWith({ source, error: 'denied' }));
  });
  it.each([
    { source, url: 'blob:clip' },
    { source, error: 'denied' },
    { source: '/old', url: 'blob:old' },
  ])('renders only the current source', (value) => {
    hooks.value = value;
    vi.mocked(loadAuthorMedia).mockReturnValue(new Promise(() => {}));
    const view = AuthorMediaPreview({ sessionId: 's', path: 'clip.mp4' });
    expect(view.props.children).toBeDefined();
    expect(view.props.children.props.src).toBe(value.source === source ? value.url : undefined);
  });
});
