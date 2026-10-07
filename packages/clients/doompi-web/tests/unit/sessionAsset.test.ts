import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeEach as beforeEachApiRoutes } from 'vitest';
beforeEachApiRoutes(() => bindSessionApiWorkspace(() => 'test-workspace'));
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { sealedHttpSession } from '../../src/web/lib/sealedSession';
import { loadSessionAsset, uploadSessionAttachment } from '../../src/web/lib/sessionAsset';

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

    expect(fetchSpy).toHaveBeenCalledWith('/api/workspaces/test-workspace/sessions/s%201/file?path=docs%2Fa%20b.png', {
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

describe('uploadSessionAttachment', () => {
  it('posts the raw file through the sealed HTTP channel and returns where it was stored', async () => {
    fetchSpy.mockResolvedValue(
      Response.json(
        { path: '/host/attachments/a b.pdf', name: 'a b.pdf', size: 4, mimeType: 'application/pdf' },
        { status: 201 },
      ),
    );
    const file = new File(['%PDF'], 'a b.pdf', { type: 'application/pdf' });

    await expect(uploadSessionAttachment('s 1', file)).resolves.toEqual({
      path: '/host/attachments/a b.pdf',
      mimeType: 'application/pdf',
      size: 4,
    });
    expect(fetchSpy).toHaveBeenCalledWith('/api/workspaces/test-workspace/sessions/s%201/attachments?name=a%20b.pdf', {
      method: 'POST',
      body: file,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/pdf' },
    });
  });

  it('sends an untyped file as octet-stream and rejects an unsuccessful response', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 413 }));

    await expect(uploadSessionAttachment('s', new File(['x'], 'blob'))).rejects.toThrow('could not be uploaded (413)');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/workspaces/test-workspace/sessions/s/attachments?name=blob',
      expect.objectContaining({ headers: { 'content-type': 'application/octet-stream' } }),
    );
  });
});
