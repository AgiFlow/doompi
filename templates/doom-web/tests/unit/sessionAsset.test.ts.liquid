import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { sealedHttpSession } from '../../src/web/lib/sealedSession.ts';
import { loadSessionAsset } from '../../src/web/lib/sessionAsset.ts';

const fetchSpy = vi.spyOn(sealedHttpSession, 'fetch');

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('loadSessionAsset', () => {
  it('fetches binary data through the sealed HTTP channel without caching', async () => {
    fetchSpy.mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2]), { headers: { 'Content-Type': 'image/png; charset=binary' } }),
    );
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:session-file');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const asset = await loadSessionAsset('s 1', 'docs/a b.png');

    expect(fetchSpy).toHaveBeenCalledWith('/api/sessions/s%201/file?path=docs%2Fa%20b.png', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(asset).toMatchObject({ url: 'blob:session-file', contentType: 'image/png' });

    asset.dispose();
    asset.dispose();
    expect(revokeUrl).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith('blob:session-file');
  });

  it('does not create an object URL for an unsuccessful response', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    const createUrl = vi.spyOn(URL, 'createObjectURL');

    await expect(loadSessionAsset('session', 'missing.txt')).rejects.toThrow('could not be loaded (404)');
    expect(createUrl).not.toHaveBeenCalled();
  });
});
