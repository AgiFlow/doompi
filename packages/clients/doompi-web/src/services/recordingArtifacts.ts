import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ComputerUseHostBinding, HubSessionScope } from '@agimon-ai/doompi-web-contracts';

const MAX_ARTIFACTS = 8;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * MAX_ARTIFACT_BYTES;
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_ROUTE = '/api/sessions';

interface RecordingFailure {
  readonly code: string;
  readonly message: string;
}

interface DesktopRecordingArtifact {
  readonly artifactId: string;
  readonly status: 'ready' | 'failed';
  readonly filePath?: string;
  readonly mimeType?: string;
  readonly actionCount?: number;
  readonly completedAt?: string;
  readonly failure?: RecordingFailure;
}

interface StoredArtifact {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly filePath: string;
  readonly size: number;
  readonly device: number;
  readonly inode: number;
  readonly mimeType: string;
  readonly createdAt: number;
}

export interface RecordingArtifactStore {
  readonly binding?: ComputerUseHostBinding;
  response(
    sessionId: string,
    artifactId: string,
    range: string | undefined,
    download: boolean,
    head: boolean,
  ): Response;
  close(): void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failure(value: unknown): RecordingFailure | undefined {
  const input = record(value);
  if (typeof input?.code !== 'string' || typeof input.message !== 'string') return undefined;
  return { code: input.code.slice(0, 128), message: input.message.slice(0, 512) };
}

function metadata(value: unknown, newId: () => string): DesktopRecordingArtifact | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  const validId = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(candidate);
  const artifactFailure = failure(input.failure);
  if (validId(input.artifactId) && (input.status === 'ready' || input.status === 'failed')) {
    return {
      artifactId: input.artifactId,
      status: input.status,
      ...(typeof input.filePath === 'string' ? { filePath: input.filePath } : {}),
      ...(typeof input.mimeType === 'string' ? { mimeType: input.mimeType } : {}),
      ...(typeof input.actionCount === 'number' && Number.isSafeInteger(input.actionCount) && input.actionCount >= 0
        ? { actionCount: input.actionCount }
        : {}),
      ...(typeof input.completedAt === 'string' ? { completedAt: input.completedAt } : {}),
      ...(artifactFailure === undefined ? {} : { failure: artifactFailure }),
    };
  }
  if (typeof input.stopped !== 'boolean') return undefined;
  const artifact = record(input.artifact);
  const artifactId = newId();
  if (
    artifact?.kind === 'screen_recording' &&
    typeof artifact.path === 'string' &&
    artifact.contentType === 'video/mp4'
  ) {
    return { artifactId, status: 'ready', filePath: artifact.path, mimeType: artifact.contentType };
  }
  return {
    artifactId,
    status: 'failed',
    failure: artifactFailure ?? {
      code: 'recording_failed',
      message: 'Desktop stopped computer use without a completed recording.',
    },
  };
}

function byteRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || size === 0) return undefined;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return undefined;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function removeFile(filePath: string): void {
  void fs.promises.unlink(filePath).catch(() => undefined);
}

export function createRecordingArtifactStore(
  desktop: ComputerUseHostBinding | undefined,
  now: () => number = Date.now,
  newId: () => string = randomUUID,
  storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-recordings-')),
): RecordingArtifactStore {
  fs.mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
  const artifacts = new Map<string, StoredArtifact>();
  let totalBytes = 0;
  const remove = (artifactId: string): void => {
    const artifact = artifacts.get(artifactId);
    if (artifact === undefined) return;
    artifacts.delete(artifactId);
    totalBytes -= artifact.size;
    removeFile(artifact.filePath);
  };
  const prune = (): void => {
    const cutoff = now() - ARTIFACT_TTL_MS;
    for (const artifact of artifacts.values()) if (artifact.createdAt <= cutoff) remove(artifact.artifactId);
    while (artifacts.size > MAX_ARTIFACTS || totalBytes > MAX_TOTAL_BYTES) {
      const oldest = artifacts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      remove(oldest);
    }
  };
  const publish = async (scope: HubSessionScope, value: unknown): Promise<unknown> => {
    const artifact = metadata(value, newId);
    if (artifact === undefined) return undefined;
    const baseUrl = `${ARTIFACT_ROUTE}/${encodeURIComponent(scope.sessionId)}/computer-use/artifacts/${encodeURIComponent(artifact.artifactId)}`;
    const publicFields = {
      artifactId: artifact.artifactId,
      ...(artifact.actionCount === undefined ? {} : { actionCount: artifact.actionCount }),
      ...(artifact.completedAt === undefined ? {} : { completedAt: artifact.completedAt }),
    };
    if (artifact.status === 'failed') {
      return {
        ...publicFields,
        status: 'failed',
        ...(artifact.failure === undefined ? {} : { failure: artifact.failure }),
      };
    }
    if (artifact.filePath === undefined || !path.isAbsolute(artifact.filePath)) {
      return {
        ...publicFields,
        status: 'failed',
        failure: { code: 'recording_unavailable', message: 'Desktop did not provide a local recording file.' },
      };
    }
    let storedPath: string | undefined;
    try {
      const sourcePath = await fs.promises.realpath(artifact.filePath);
      const sourceStats = await fs.promises.stat(sourcePath);
      if (!sourceStats.isFile() || sourceStats.size > MAX_ARTIFACT_BYTES)
        throw new Error('The recording exceeds the local storage limit.');
      const previous = artifacts.get(artifact.artifactId);
      if (previous !== undefined) remove(previous.artifactId);
      storedPath = path.join(storageDirectory, `${artifact.artifactId}.mp4`);
      await fs.promises.copyFile(sourcePath, storedPath, fsConstants.COPYFILE_EXCL);
      await fs.promises.chmod(storedPath, 0o600);
      const stats = await fs.promises.stat(storedPath);
      if (!stats.isFile() || stats.size !== sourceStats.size) throw new Error('The recording copy is incomplete.');
      const mimeType = artifact.mimeType?.startsWith('video/') === true ? artifact.mimeType : 'video/mp4';
      artifacts.set(artifact.artifactId, {
        artifactId: artifact.artifactId,
        sessionId: scope.sessionId,
        filePath: storedPath,
        size: stats.size,
        device: stats.dev,
        inode: stats.ino,
        mimeType,
        createdAt: now(),
      });
      totalBytes += stats.size;
      prune();
      if (!artifacts.has(artifact.artifactId)) throw new Error('The recording exceeds the local storage budget.');
      return { ...publicFields, status: 'ready', previewUrl: baseUrl, downloadUrl: `${baseUrl}?download=1` };
    } catch (error) {
      if (storedPath !== undefined) removeFile(storedPath);
      return {
        ...publicFields,
        status: 'failed',
        failure: {
          code: 'recording_unavailable',
          message: error instanceof Error ? error.message.slice(0, 512) : 'The recording is unavailable.',
        },
      };
    }
  };

  const binding =
    desktop === undefined
      ? undefined
      : ({
          available: desktop.available,
          request: async (scope, request) => {
            const result = await desktop.request(scope, request);
            return request.operation === 'stop' ? await publish(scope, result) : result;
          },
          close: desktop.close === undefined ? undefined : () => desktop.close?.(),
        } satisfies ComputerUseHostBinding);

  return {
    binding,
    response(sessionId, artifactId, rangeHeader, download, head) {
      prune();
      const artifact = artifacts.get(artifactId);
      if (artifact === undefined || artifact.sessionId !== sessionId)
        return Response.json({ error: 'No such recording.' }, { status: 404 });
      let descriptor: number;
      let stats: fs.Stats;
      try {
        descriptor = fs.openSync(artifact.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        stats = fs.fstatSync(descriptor);
      } catch {
        remove(artifactId);
        return Response.json({ error: 'The recording is no longer available.' }, { status: 410 });
      }
      if (
        !stats.isFile() ||
        stats.size !== artifact.size ||
        stats.dev !== artifact.device ||
        stats.ino !== artifact.inode
      ) {
        fs.closeSync(descriptor);
        remove(artifactId);
        return Response.json({ error: 'The recording changed after it was registered.' }, { status: 410 });
      }
      const commonHeaders = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'Content-Type': artifact.mimeType,
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${artifact.artifactId}.mp4"`,
      };
      const range = rangeHeader === undefined ? undefined : byteRange(rangeHeader, artifact.size);
      if (rangeHeader !== undefined && range === undefined) {
        fs.closeSync(descriptor);
        return new Response(null, {
          status: 416,
          headers: { ...commonHeaders, 'Content-Range': `bytes */${String(artifact.size)}` },
        });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? artifact.size - 1;
      const length = artifact.size === 0 ? 0 : end - start + 1;
      const headers = {
        ...commonHeaders,
        'Content-Length': String(length),
        ...(range === undefined
          ? {}
          : { 'Content-Range': `bytes ${String(start)}-${String(end)}/${String(artifact.size)}` }),
      };
      if (head || artifact.size === 0) {
        fs.closeSync(descriptor);
        return new Response(null, { status: range === undefined ? 200 : 206, headers });
      }
      const body = Readable.toWeb(
        fs.createReadStream(artifact.filePath, { fd: descriptor, autoClose: true, start, end }),
      ) as ReadableStream<Uint8Array>;
      return new Response(body, { status: range === undefined ? 200 : 206, headers });
    },
    close() {
      for (const artifactId of artifacts.keys()) remove(artifactId);
      desktop?.close?.();
    },
  };
}
