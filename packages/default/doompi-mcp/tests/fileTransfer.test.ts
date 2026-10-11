import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import { Value } from 'typebox/value';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SaveFileParameters } from '../src/schemas/fileTransfer';
import { createFileTransferTools } from '../src/services/fileTransfer';
import { decodeFileBase64, downloadPublicFile, isPublicAddress } from '../src/services/fileTransfer/download';
import { writeCwdFile } from '../src/services/fileTransfer/storage';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
describe('file transfer', () => {
  it('requires exactly one complete file form', () => {
    expect(Value.Check(SaveFileParameters, { file: { name: 'a', data_base64: '' } })).toBe(true);
    expect(Value.Check(SaveFileParameters, { file: { download_url: 'https://example.com/a', file_name: 'a' } })).toBe(
      true,
    );
    expect(
      Value.Check(SaveFileParameters, {
        file: { name: 'a', data_base64: '', download_url: 'https://example.com', file_name: 'a' },
      }),
    ).toBe(false);
  });
  it('validates base64 and decoded size before allocation', () => {
    expect(decodeFileBase64('aGk=').toString()).toBe('hi');
    expect(decodeFileBase64(Buffer.alloc(5 * 1024 * 1024).toString('base64')).length).toBe(5 * 1024 * 1024);
    for (const input of ['!', 'a', 'a===', 'a'.repeat(7 * 1024 * 1024)])
      expect(() => decodeFileBase64(input)).toThrow();
    expect(() => decodeFileBase64(Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'))).toThrow();
  });
  it('refuses local, reserved, credentialed and non-HTTPS URLs', async () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '2001:db8::1',
    ])
      expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://127.0.0.1'])
      await expect(downloadPublicFile(url)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(downloadPublicFile('https://example.com', controller.signal)).rejects.toThrow();
  });
  it('writes private exclusive files only through existing safe parents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doom-transfer-'));
    roots.push(root);
    const target = await writeCwdFile(root, 'a.txt', Buffer.from('hi'));
    expect(await fs.readFile(target, 'utf8')).toBe('hi');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    await expect(writeCwdFile(root, 'a.txt', Buffer.from('bad'))).rejects.toThrow();
    await fs.symlink(root, path.join(root, 'link'));
    for (const name of ['../escape', '/absolute', 'link/new', 'missing/new', './new'])
      await expect(writeCwdFile(root, name, Buffer.from('bad'))).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe('hi');
  });
});

describe('session-bound share tool', () => {
  it.each([
    { index: 0, input: {}, message: 'Invalid share_file parameters.' },
    { index: 1, input: { file: { name: 'a' } }, message: 'Provide exactly one file form.' },
    { index: 0, input: { path: 'a' }, message: 'File sharing is unavailable.' },
    { index: 1, input: { file: { name: 'a', data_base64: '' } }, message: 'Session file storage is unavailable.' },
  ])('rejects invalid arguments or unavailable services: $message', async ({ index, input, message }) => {
    await expect(
      createFileTransferTools()[index].execute('call', input, undefined, undefined, {} as DoomHeadlessExecutionContext),
    ).rejects.toThrow(message);
  });
  it('returns actual host fields without consent or revoking completed shares', async () => {
    const revoke = vi.fn();
    const shareFile = vi.fn(async () => ({
      url: 'https://example.com/file',
      fileName: 'a',
      mimeType: 'text/plain',
      size: 1,
      expiresAt: 123,
      maxDownloads: 3,
      revoke,
    }));
    const owner = { host: { context: { shareFile } } } as unknown as DoomServerPluginContext;
    const tool = createFileTransferTools(owner)[0];
    expect(tool._meta?.['doompi/fileTransfer']).toBe(true);
    const result = await tool.execute('call', { path: 'a' }, undefined, undefined, {} as DoomHeadlessExecutionContext);
    expect(result.structuredContent).toEqual({
      url: 'https://example.com/file',
      fileName: 'a',
      mimeType: 'text/plain',
      size: 1,
      expiresAt: 123,
      maxDownloads: 3,
    });
    expect(shareFile).toHaveBeenCalledWith('a', 'share_file');
    expect(revoke).not.toHaveBeenCalled();
  });
  it('revokes a delayed mint cancelled through the bound owner', async () => {
    const controller = new AbortController();
    const revoke = vi.fn();
    const shareFile = vi.fn(async () => {
      controller.abort(new Error('cancelled'));
      return {
        url: 'https://example.com/file',
        fileName: 'a',
        mimeType: 'text/plain',
        size: 1,
        expiresAt: 123,
        maxDownloads: 3,
        revoke,
      };
    });
    const owner = { signal: controller.signal, host: { context: { shareFile } } } as unknown as DoomServerPluginContext;
    await expect(
      createFileTransferTools(owner)[0].execute(
        'call',
        { path: 'a' },
        undefined,
        undefined,
        {} as DoomHeadlessExecutionContext,
      ),
    ).rejects.toThrow('cancelled');
    expect(revoke).toHaveBeenCalledOnce();
  });
});
