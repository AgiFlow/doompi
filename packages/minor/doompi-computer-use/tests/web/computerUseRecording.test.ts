import { afterEach, describe, expect, it, vi } from 'vitest';

const { artifact } = vi.hoisted(() => ({ artifact: vi.fn() }));
vi.mock('../../generated/client', () => ({ api: { session: () => ({ artifact }) } }));
import { loadComputerUseRecording } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/computerUseRecording';

afterEach(() => {
  vi.restoreAllMocks();
  artifact.mockReset();
});
describe('sealed computer-use recording download', () => {
  it('fetches bounded chunks through the generated API and disposes Blob URLs exactly once', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const size = 1024 * 1024 + 3;
    artifact.mockImplementation(async ({ query }: { query: { offset: number } }) => {
      const end = Math.min(query.offset + 1024 * 1024, size) - 1;
      return {
        ok: true,
        status: 206,
        response: new Response(new Uint8Array(end - query.offset + 1), {
          status: 206,
          headers: { 'content-range': `bytes ${query.offset}-${end}/${size}` },
        }),
      };
    });
    const controller = new AbortController();
    const recording = await loadComputerUseRecording('session', 'artifact-id', size, controller.signal);
    expect(artifact).toHaveBeenCalledTimes(2);
    expect(artifact.mock.calls[1]?.[0]).toMatchObject({
      query: { artifactId: 'artifact-id', offset: 1024 * 1024 },
      signal: controller.signal,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(recording.url).toBe('blob:recording');
    recording.dispose();
    recording.dispose();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:recording');
  });
  it('refuses revoked, malformed, oversized and cancelled transfers without creating a URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    artifact.mockResolvedValue({ ok: false, status: 404 });
    await expect(loadComputerUseRecording('s', 'id', 3, new AbortController().signal)).rejects.toThrow(
      'access was revoked',
    );
    artifact.mockResolvedValue({ ok: true, status: 206, response: new Response('123', { status: 206 }) });
    await expect(loadComputerUseRecording('s', 'id', 3, new AbortController().signal)).rejects.toThrow('invalid');
    await expect(
      loadComputerUseRecording('s', 'id', 128 * 1024 * 1024 + 1, new AbortController().signal),
    ).rejects.toThrow('permitted size');
    const controller = new AbortController();
    controller.abort();
    await expect(loadComputerUseRecording('s', 'id', 3, controller.signal)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
