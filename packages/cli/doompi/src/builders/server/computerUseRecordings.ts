import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_RECORDING_BYTES = 128 * 1024 * 1024;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const MAX_RECORDINGS = 8;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 1024 * 1024;
const SAFE_ID = /^[a-zA-Z0-9-]{1,128}$/u;

type Recording = {
  sessionId: string;
  grantId: string;
  artifactId: string;
  sizeBytes: number;
  completedAt: string;
  file: string;
};

/** Imports only grant-bound native IPC receipts, never browser-provided paths. */
export class ComputerUseRecordingStore {
  private readonly recordings = new Map<string, Recording>();
  private readonly imports = new Map<string, Promise<unknown>>();
  private closed = false;
  private readonly incarnations = new Map<string, number>();
  constructor(
    private readonly directory: string,
    private readonly stagingRoot = path.join(os.tmpdir(), 'doompi-computer-use'),
  ) {}

  private async prune(): Promise<void> {
    let bytes = [...this.recordings.values()].reduce((total, item) => total + item.sizeBytes, 0);
    for (const [id, item] of this.recordings) {
      if (
        Date.now() - Date.parse(item.completedAt) < RETENTION_MS &&
        this.recordings.size <= MAX_RECORDINGS &&
        bytes <= MAX_STORE_BYTES
      )
        break;
      this.recordings.delete(id);
      this.imports.delete(`${item.sessionId}\0${item.grantId}`);
      bytes -= item.sizeBytes;
      await fs.rm(item.file, { force: true });
    }
  }

  async importStop(sessionId: string, grantId: string, value: unknown): Promise<unknown> {
    if (this.closed) throw new Error('Recording storage is closed.');
    const key = `${sessionId}\0${grantId}`;
    const previous = this.imports.get(key);
    if (previous) return previous;
    const pending = this.importReceipt(sessionId, grantId, value);
    this.imports.set(key, pending);
    try {
      const result = await pending;
      if (!(result as { artifact?: unknown } | undefined)?.artifact) this.imports.delete(key);
      return result;
    } catch {
      this.imports.delete(key);
      throw new Error('Native recording import failed.');
    }
  }

  private async importReceipt(sessionId: string, grantId: string, value: unknown): Promise<unknown> {
    const receipt = value as {
      stopped?: unknown;
      artifact?: { kind?: unknown; path?: unknown; contentType?: unknown; audioScope?: unknown };
    } | null;
    if (receipt?.stopped !== true || receipt.artifact === undefined) return { stopped: receipt?.stopped === true };
    const incarnation = this.incarnations.get(sessionId) ?? 0;
    const artifact = receipt.artifact;
    if (
      !SAFE_ID.test(grantId) ||
      artifact.kind !== 'screen_recording' ||
      artifact.contentType !== 'video/mp4' ||
      artifact.audioScope !== 'target_application'
    )
      throw new Error('Invalid native recording receipt.');
    const grantDirectory = path.join(this.stagingRoot, grantId);
    const source = path.join(grantDirectory, 'recording.mp4');
    if (artifact.path !== source) throw new Error('Invalid native recording location.');
    for (const directory of [this.stagingRoot, grantDirectory]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        throw new Error('Recording staging is not private.');
    }
    const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const artifactId = randomUUID();
    const destination = path.join(this.directory, `${artifactId}.mp4`);
    const temporary = `${destination}.tmp`;
    let output: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RECORDING_BYTES)
        throw new Error('Recording exceeds the permitted size.');
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const root = await fs.lstat(this.directory);
      if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0)
        throw new Error('Recording storage is not private.');
      output = await fs.open(temporary, 'wx', 0o600);
      const buffer = Buffer.alloc(CHUNK_BYTES);
      let copied = 0;
      while (true) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        copied += bytesRead;
        if (copied > MAX_RECORDING_BYTES || copied > stat.size) throw new Error('Recording changed during import.');
        await output.writeFile(buffer.subarray(0, bytesRead));
      }
      if (copied !== stat.size) throw new Error('Recording changed during import.');
      await output.sync();
      await output.close();
      output = undefined;
      if (this.closed || (this.incarnations.get(sessionId) ?? 0) !== incarnation)
        throw new Error('Recording storage is closed.');
      await fs.rename(temporary, destination);
      if (this.closed || (this.incarnations.get(sessionId) ?? 0) !== incarnation) {
        await fs.rm(destination, { force: true });
        throw new Error('Recording storage is closed.');
      }
      const item = {
        sessionId,
        grantId,
        artifactId,
        sizeBytes: copied,
        completedAt: new Date().toISOString(),
        file: destination,
      };
      this.recordings.set(artifactId, item);
      await this.prune();
      await fs.unlink(source);
      await fs.rmdir(grantDirectory);
      return {
        stopped: true,
        artifact: { artifactId, status: 'ready', sizeBytes: copied, completedAt: item.completedAt },
      };
    } catch {
      this.recordings.delete(artifactId);
      await fs.rm(temporary, { force: true });
      await fs.rm(destination, { force: true });
      throw new Error('Native recording import failed.');
    } finally {
      await output?.close();
      await input.close();
    }
  }

  async forgetSession(sessionId: string): Promise<void> {
    this.incarnations.set(sessionId, (this.incarnations.get(sessionId) ?? 0) + 1);
    const files: string[] = [];
    for (const [id, item] of this.recordings) {
      if (item.sessionId !== sessionId) continue;
      this.recordings.delete(id);
      files.push(item.file);
    }
    for (const key of this.imports.keys()) if (key.startsWith(`${sessionId}\0`)) this.imports.delete(key);
    await Promise.all(files.map((file) => fs.rm(file, { force: true })));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.imports.values());
    this.imports.clear();
    this.recordings.clear();
    await fs.rm(this.directory, { recursive: true, force: true });
  }

  async read(sessionId: string, artifactId: string, range: string | undefined): Promise<Response> {
    if (this.closed) return new Response(null, { status: 404 });
    await this.prune();
    const item = this.recordings.get(artifactId);
    if (!item || item.sessionId !== sessionId) return new Response(null, { status: 404 });
    const match = /^bytes=(\d+)-(\d+)$/u.exec(range ?? '');
    const start = Number(match?.[1]);
    const requestedEnd = Number(match?.[2]);
    if (
      !match ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start < 0 ||
      start >= item.sizeBytes ||
      requestedEnd < start ||
      requestedEnd - start >= CHUNK_BYTES
    )
      return new Response(null, { status: 416 });
    const end = Math.min(requestedEnd, item.sizeBytes - 1);
    const input = await fs.open(item.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (input === undefined) return new Response(null, { status: 410 });
    try {
      const bytes = Buffer.alloc(end - start + 1);
      const { bytesRead } = await input.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) return new Response(null, { status: 410 });
      return new Response(bytes, {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${item.sizeBytes}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          'content-length': String(bytes.length),
        },
      });
    } finally {
      await input.close();
    }
  }
}
