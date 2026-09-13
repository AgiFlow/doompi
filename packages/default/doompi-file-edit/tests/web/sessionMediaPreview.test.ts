import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionMediaPreview } from '../../src/web/components/SessionMediaPreview';

const hooks = vi.hoisted(() => ({
  set: vi.fn(),
  cleanup: undefined as undefined | (() => void),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: () => [undefined, hooks.set],
  useEffect: (effect: () => () => void) => {
    hooks.cleanup = effect();
  },
}));
vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));
afterEach(() => {
  hooks.cleanup?.();
  hooks.cleanup = undefined;
  vi.restoreAllMocks();
  hooks.set.mockClear();
});

describe('remote file media preview', () => {
  it.each(['image/gif', 'video/mp4'])('fetches %s through the sealed transport and revokes the URL', async (type) => {
    vi.mocked(sealedTransport.fetch).mockResolvedValue(new Response('media', { headers: { 'content-type': type } }));
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:media');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    SessionMediaPreview({ src: '/api/sessions/s/file?path=clip', path: 'clip' });
    await vi.waitFor(() =>
      expect(hooks.set).toHaveBeenCalledWith({ source: '/api/sessions/s/file?path=clip', url: 'blob:media' }),
    );
    expect(sealedTransport.fetch).toHaveBeenCalledWith(
      '/api/sessions/s/file?path=clip',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect((create.mock.calls[0]![0] as Blob).type).toBe(type);
    hooks.cleanup?.();
    hooks.cleanup = undefined;
    expect(revoke).toHaveBeenCalledWith('blob:media');
  });

  it('reports rejected delivery instead of handing an API URL to the browser', async () => {
    vi.mocked(sealedTransport.fetch).mockResolvedValue(new Response('', { status: 403 }));
    const create = vi.spyOn(URL, 'createObjectURL');
    SessionMediaPreview({ src: '/api/file', path: 'clip.mp4' });
    await vi.waitFor(() =>
      expect(hooks.set).toHaveBeenCalledWith({ source: '/api/file', error: 'Media could not be loaded (403).' }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('discards a response arriving after unmount', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(sealedTransport.fetch).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const create = vi.spyOn(URL, 'createObjectURL');
    SessionMediaPreview({ src: '/api/file', path: 'clip.mp4' });
    hooks.cleanup?.();
    resolve(new Response('media'));
    await new Promise((done) => setTimeout(done, 0));
    expect(create).not.toHaveBeenCalled();
    expect(hooks.set).not.toHaveBeenCalled();
  });
});
