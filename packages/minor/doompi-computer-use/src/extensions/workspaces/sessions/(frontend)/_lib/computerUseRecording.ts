import { api } from '../../../../../../generated/client';

const MAX_RECORDING_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

/** Owns only a bounded sealed download and its disposable browser URL. */
export async function loadComputerUseRecording(
  sessionId: string,
  artifactId: string,
  sizeBytes: number,
  signal: AbortSignal,
): Promise<{ url: string; dispose(): void }> {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_RECORDING_BYTES)
    throw new Error('Recording exceeds the permitted size.');
  const parts: ArrayBuffer[] = [];
  for (let offset = 0; offset < sizeBytes; offset += CHUNK_BYTES) {
    signal.throwIfAborted();
    const result = await api.session(sessionId).artifact({ query: { artifactId, offset }, signal });
    if (!result.ok || result.status !== 206) throw new Error('The recording is unavailable or access was revoked.');
    const end = Math.min(offset + CHUNK_BYTES, sizeBytes) - 1;
    if (result.response.headers.get('content-range') !== `bytes ${offset}-${end}/${sizeBytes}`)
      throw new Error('The recording response is invalid.');
    const bytes = await result.response.arrayBuffer();
    signal.throwIfAborted();
    if (bytes.byteLength !== end - offset + 1) throw new Error('The recording response is incomplete.');
    parts.push(bytes);
  }
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob(parts, { type: 'video/mp4' }));
  let disposed = false;
  return {
    url,
    dispose() {
      if (!disposed) {
        disposed = true;
        URL.revokeObjectURL(url);
      }
    },
  };
}
