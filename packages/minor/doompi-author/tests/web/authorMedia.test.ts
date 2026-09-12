import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { loadAuthorMedia } from '../../src/web/api/authorMedia';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());

describe('Author remote media', () => {
  it.each(['image/gif', 'video/mp4'])('uses decrypted %s bytes instead of a raw API URL', async (type) => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.mocked(sealedTransport.fetch).mockResolvedValue(new Response(bytes, { headers: { 'content-type': type } }));
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:review');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const signal = new AbortController().signal;
    const asset = await loadAuthorMedia('/api/sessions/s/file?path=review', signal);
    expect(sealedTransport.fetch).toHaveBeenCalledWith('/api/sessions/s/file?path=review', {
      signal,
      cache: 'no-store',
    });
    const blob = create.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe(type);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(asset.url).toBe('blob:review');
    asset.dispose();
    asset.dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:review');
  });

  it('does not create a URL for failed or cancelled delivery', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    const controller = new AbortController();
    vi.mocked(sealedTransport.fetch).mockResolvedValue(new Response('', { status: 403 }));
    await expect(loadAuthorMedia('/asset', controller.signal)).rejects.toThrow('403');
    controller.abort();
    vi.mocked(sealedTransport.fetch).mockResolvedValue(new Response('bytes'));
    await expect(loadAuthorMedia('/asset', controller.signal)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
