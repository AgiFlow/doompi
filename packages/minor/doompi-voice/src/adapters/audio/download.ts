/**
 * Fetches a model file to disk, with progress and a pinned checksum.
 *
 * The first downloader in this repo, so it follows the conventions of its
 * neighbours rather than inventing new ones: an injected `fetch` the way
 * doom-log's metrics source takes one, and the write-to-temp-then-rename publish
 * that `atomicJson.ts` uses. The rename is what makes a half-finished download
 * invisible: a reader sees the whole file or no file, never a truncated one that
 * the transcriber would later fail on in a confusing way.
 *
 * The checksum is verified against the bytes as they arrive rather than by
 * re-reading afterwards, so a mismatch costs nothing extra and the bad file is
 * removed before it can be published.
 *
 * AVOID:
 * - Publishing before the checksum matches
 * - Leaving the temporary file behind on failure or abort
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export interface DownloadProgress {
  receivedBytes: number;
  /** Absent when the response carries no length and the total is unknowable. */
  totalBytes?: number;
}

export interface DownloadRequest {
  url: string;
  targetPath: string;
  sha256: string;
  /** Falls back to `content-length` when omitted. */
  expectedBytes?: number;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export type FetchLike = typeof globalThis.fetch;

/**
 * Downloads to `targetPath`, or throws having written nothing there.
 *
 * Resolves to the target path so callers can write it straight into config.
 */
export async function downloadModelFile(request: DownloadRequest, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(request.url, request.signal ? { signal: request.signal } : {});
  if (!response.ok) throw new Error(`Download failed with ${response.status} for ${request.url}`);
  if (!response.body) throw new Error(`Download returned no body for ${request.url}`);

  const headerLength = Number(response.headers.get('content-length'));
  const totalBytes =
    request.expectedBytes ?? (Number.isFinite(headerLength) && headerLength > 0 ? headerLength : undefined);

  await fsPromises.mkdir(path.dirname(request.targetPath), { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const temporaryPath = `${request.targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fsPromises.open(temporaryPath, 'w', PRIVATE_FILE_MODE);
  const hash = createHash('sha256');
  let receivedBytes = 0;

  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      request.signal?.throwIfAborted();
      hash.update(chunk);
      receivedBytes += chunk.byteLength;
      await handle.write(chunk);
      request.onProgress?.({ receivedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
    }
    await handle.close();

    const digest = hash.digest('hex');
    if (digest !== request.sha256) {
      throw new Error(
        `Checksum mismatch for ${path.basename(request.targetPath)}: expected ${request.sha256}, got ${digest}`,
      );
    }
    await fsPromises.rename(temporaryPath, request.targetPath);
    return request.targetPath;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsPromises.rm(temporaryPath, { force: true });
    throw error;
  }
}

/** True when the file is present and matches, so a repeat install is a no-op. */
export async function isDownloaded(targetPath: string, expectedBytes: number | undefined): Promise<boolean> {
  try {
    const stats = await fsPromises.stat(targetPath);
    if (!stats.isFile()) return false;
    // Size only: hashing 1.6 GB every time the panel opens would be the slowest
    // thing in the session, and a corrupt file surfaces at transcribe time.
    return expectedBytes === undefined || stats.size === expectedBytes;
  } catch {
    return false;
  }
}

export function modelsDirectory(configDirectory: string): string {
  return path.join(configDirectory, 'models');
}

export function ensureModelsDirectory(configDirectory: string): string {
  const directory = modelsDirectory(configDirectory);
  fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  return directory;
}
