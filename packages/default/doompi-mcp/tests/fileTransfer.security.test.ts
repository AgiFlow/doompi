import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadPublicFile } from '../src/services/fileTransfer/download';
import { writeCwdFile } from '../src/services/fileTransfer/storage';

const LIMIT = 25 * 1024 * 1024;
const PUBLIC = { address: '8.8.8.8', family: 4 };
const roots: string[] = [];
const dnsMock = () =>
  vi.mocked(dns.lookup as unknown as (host: string, options: { all: true }) => Promise<LookupAddress[]>);
type Reply = { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; stalled?: boolean };
let replies: Reply[];
let responses: PassThrough[];
let signals: AbortSignal[];

beforeEach(() => {
  replies = [];
  responses = [];
  signals = [];
  vi.spyOn(dns, 'lookup');
  dnsMock().mockResolvedValue([PUBLIC]);
  vi.spyOn(https, 'get').mockImplementation(((
    url: URL,
    options: https.RequestOptions,
    callback: (response: unknown) => void,
  ) => {
    const request = new EventEmitter();
    const signal = options.signal!;
    signals.push(signal);
    signal.addEventListener('abort', () => request.emit('error', signal.reason), { once: true });
    const reply = replies.shift();
    if (!reply) throw new Error(`Unexpected request: ${url.href}`);
    const response = Object.assign(new PassThrough(), {
      statusCode: reply.status ?? 200,
      headers: reply.headers ?? {},
    });
    responses.push(response);
    queueMicrotask(() => {
      callback(response);
      if (!reply.stalled && !response.destroyed) {
        for (const chunk of reply.chunks ?? []) response.write(chunk);
        response.end();
      }
    });
    return request;
  }) as unknown as typeof https.get);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('downloader security boundaries with mocked HTTPS', () => {
  it('pins socket lookup to the validated first DNS answer in both lookup modes', async () => {
    replies.push({ chunks: [Buffer.from('ok')] });
    expect((await downloadPublicFile('https://files.example/a')).toString()).toBe('ok');
    expect(dns.lookup).toHaveBeenCalledWith('files.example', { all: true });
    const options = vi.mocked(https.get).mock.calls[0][1] as https.RequestOptions;
    expect(options.agent).toBe(false);
    const lookup = options.lookup!;
    const callback = vi.fn();
    lookup('files.example', {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, PUBLIC.address, PUBLIC.family);
    lookup('files.example', { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [PUBLIC]);
  });

  it.each([{ answers: [] }, { answers: [PUBLIC, { address: '10.0.0.1', family: 4 }] }])(
    'rejects empty or mixed-public DNS answers before HTTPS: %j',
    async ({ answers }) => {
      dnsMock().mockResolvedValue(answers);
      await expect(downloadPublicFile('https://files.example/a')).rejects.toThrow('public addresses');
      expect(https.get).not.toHaveBeenCalled();
    },
  );

  it('rejects credentials before DNS or HTTPS', async () => {
    await expect(downloadPublicFile('https://user:secret@files.example/a')).rejects.toThrow('credentials');
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(https.get).not.toHaveBeenCalled();
  });

  it('revalidates redirected DNS and refuses a public-to-private hop', async () => {
    dnsMock()
      .mockResolvedValueOnce([PUBLIC])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    replies.push({ status: 302, headers: { location: 'https://private.example/a' } });
    await expect(downloadPublicFile('https://files.example/a')).rejects.toThrow('public addresses');
    expect(dns.lookup).toHaveBeenNthCalledWith(2, 'private.example', { all: true });
    expect(https.get).toHaveBeenCalledTimes(1);
    expect(responses[0].destroyed).toBe(true);
  });

  it.each([3, 4])('allows at most three redirects (%i redirects)', async (count) => {
    for (let i = 0; i < count; i += 1) replies.push({ status: 302, headers: { location: `/hop${i}` } });
    replies.push({ chunks: [Buffer.from('done')] });
    const result = downloadPublicFile('https://files.example/a');
    if (count === 3) expect((await result).toString()).toBe('done');
    else await expect(result).rejects.toThrow('Too many redirects');
    expect(https.get).toHaveBeenCalledTimes(4);
    expect(dns.lookup).toHaveBeenCalledTimes(4);
  });

  it('refuses advertised overflow without reading the body', async () => {
    replies.push({ headers: { 'content-length': String(LIMIT + 1) }, chunks: [Buffer.from('unused')] });
    await expect(downloadPublicFile('https://files.example/a')).rejects.toThrow('size limit');
    expect(responses[0].destroyed).toBe(true);
  });

  it.each([LIMIT, LIMIT + 1])('enforces streamed cap even without content-length (%i bytes)', async (size) => {
    replies.push({ chunks: [Buffer.alloc(size)] });
    const result = downloadPublicFile('https://files.example/a');
    if (size === LIMIT) expect((await result).length).toBe(LIMIT);
    else {
      await expect(result).rejects.toThrow('25 MiB');
      expect(responses[0].destroyed).toBe(true);
    }
  });

  it('propagates cancellation to a stalled HTTPS request', async () => {
    replies.push({ stalled: true });
    const controller = new AbortController();
    const result = downloadPublicFile('https://files.example/a', controller.signal);
    const assertion = expect(result).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(https.get).toHaveBeenCalledTimes(1));
    controller.abort(new Error('cancelled'));
    await assertion;
    expect(signals[0].aborted).toBe(true);
  });

  it('rejects a truncated response instead of returning partial bytes', async () => {
    replies.push({ stalled: true });
    const result = downloadPublicFile('https://files.example/a');
    const assertion = expect(result).rejects.toThrow('interrupted');
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    responses[0].write(Buffer.from('partial'));
    responses[0].emit('aborted');
    responses[0].destroy();
    await assertion;
  });

  it('cancels while DNS is pending without starting HTTPS', async () => {
    dnsMock().mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = downloadPublicFile('https://files.example/a', controller.signal);
    const assertion = expect(result).rejects.toThrow('DNS cancelled');
    controller.abort(new Error('DNS cancelled'));
    await assertion;
    expect(https.get).not.toHaveBeenCalled();
  });

  it('uses a 30-second deadline and rejects a stalled request when it fires', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    replies.push({ stalled: true });
    const result = downloadPublicFile('https://files.example/a');
    const assertion = expect(result).rejects.toThrow('deadline');
    await vi.waitFor(() => expect(https.get).toHaveBeenCalledTimes(1));
    expect(timeout).toHaveBeenCalledWith(30_000);
    deadline.abort(new Error('deadline'));
    await assertion;
  });
});

describe('storage security on real temporary files', () => {
  it('closes the exclusive handle when its initial stat fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doom-security-'));
    roots.push(root);
    const open = fs.open.bind(fs);
    const close = vi.fn();
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      vi.spyOn(handle, 'stat').mockRejectedValue(new Error('stat failure'));
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        close();
        await originalClose();
      });
      return handle;
    });
    await expect(writeCwdFile(root, 'new', Buffer.from('data'))).rejects.toThrow('stat failure');
    expect(close).toHaveBeenCalledTimes(1);
    expect((await fs.stat(path.join(root, 'new'))).size).toBe(0);
  });
  it('refuses a final symlink without overwriting its referent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doom-security-'));
    roots.push(root);
    const original = path.join(root, 'original');
    await fs.writeFile(original, 'keep');
    await fs.symlink(original, path.join(root, 'link'));
    await expect(writeCwdFile(root, 'link', Buffer.from('replace'))).rejects.toThrow();
    expect(await fs.readFile(original, 'utf8')).toBe('keep');
    expect((await fs.lstat(path.join(root, 'link'))).isSymbolicLink()).toBe(true);
  });

  it('truncates its exclusive file and closes the handle after a write failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doom-security-'));
    roots.push(root);
    const open = fs.open.bind(fs);
    const close = vi.fn();
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
        await write(Buffer.from('partial'));
        throw new Error('disk failure');
      });
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        close();
        await originalClose();
      });
      return handle;
    });
    await expect(writeCwdFile(root, 'new', Buffer.from('data'))).rejects.toThrow('disk failure');
    expect(await fs.readdir(root)).toEqual(['new']);
    expect((await fs.stat(path.join(root, 'new'))).size).toBe(0);
    expect((await fs.stat(path.join(root, 'new'))).mode & 0o777).toBe(0o600);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('preserves an unrelated replacement at the failed write pathname', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doom-security-'));
    roots.push(root);
    const target = path.join(root, 'new');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
        await write(Buffer.from('partial'));
        await fs.unlink(target);
        await fs.writeFile(target, 'unrelated replacement');
        throw new Error('disk failure');
      });
      return handle;
    });
    await expect(writeCwdFile(root, 'new', Buffer.from('data'))).rejects.toThrow('disk failure');
    expect(await fs.readFile(target, 'utf8')).toBe('unrelated replacement');
  });
});
