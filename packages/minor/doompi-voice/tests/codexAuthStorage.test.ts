import { describe, expect, it, vi } from 'vitest';
import { createDoomPiCodexFileAuthStorage, type DoomPiAuthFileIo } from '../src/services/codexAuthStorage';

const signal = new AbortController().signal;

function fixture() {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const io: DoomPiAuthFileIo = {
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    async writeFile(path, value) {
      if (files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(path, value);
    },
    async rename(from, to) {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    async unlink(path) {
      files.delete(path);
    },
    async mkdir(path) {
      if (directories.has(path)) throw Object.assign(new Error('locked'), { code: 'EEXIST' });
      directories.add(path);
    },
    async rmdir(path) {
      directories.delete(path);
    },
    async sleep() {},
  };
  return { files, directories, io };
}

describe('DoomPi Codex auth file storage', () => {
  it('holds an exclusive process lock through private temporary write and rename', async () => {
    const { files, directories, io } = fixture();
    const writeFile = vi.spyOn(io, 'writeFile');
    const storage = createDoomPiCodexFileAuthStorage({
      authFilePath: '/doompi/auth.json',
      lockPath: '/doompi/auth.lock',
      temporaryPath: () => '/doompi/auth.tmp',
      io,
    });
    await storage.runExclusive(signal, async (transaction) => {
      expect(directories.has('/doompi/auth.lock')).toBe(true);
      await transaction.write('{"owned":true}', signal);
    });
    expect(directories.has('/doompi/auth.lock')).toBe(false);
    expect(files.get('/doompi/auth.json')).toBe('{"owned":true}');
    expect(writeFile).toHaveBeenCalledWith('/doompi/auth.tmp', '{"owned":true}', { flag: 'wx', mode: 0o600, signal });
  });

  it('bounds lock contention and never enters the transaction without the lock', async () => {
    const { directories, io } = fixture();
    directories.add('/doompi/auth.lock');
    const operation = vi.fn();
    const storage = createDoomPiCodexFileAuthStorage({
      authFilePath: '/doompi/auth.json',
      lockPath: '/doompi/auth.lock',
      temporaryPath: () => '/doompi/auth.tmp',
      io,
      lockAttempts: 2,
      lockRetryMs: 0,
    });
    await expect(storage.runExclusive(signal, operation)).rejects.toMatchObject({ code: 'auth_lock_timeout' });
    expect(operation).not.toHaveBeenCalled();
  });
  it('releases the lock when the transaction callback throws synchronously', async () => {
    const { directories, io } = fixture();
    const storage = createDoomPiCodexFileAuthStorage({
      authFilePath: '/doompi/auth.json',
      lockPath: '/doompi/auth.lock',
      temporaryPath: () => '/doompi/auth.tmp',
      io,
    });
    await expect(
      storage.runExclusive(signal, () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(directories.has('/doompi/auth.lock')).toBe(false);
  });

  it('does not delete a temporary file it failed to create exclusively', async () => {
    const { files, directories, io } = fixture();
    files.set('/doompi/auth.tmp', 'belongs to another operation');
    const storage = createDoomPiCodexFileAuthStorage({
      authFilePath: '/doompi/auth.json',
      lockPath: '/doompi/auth.lock',
      temporaryPath: () => '/doompi/auth.tmp',
      io,
    });
    await expect(storage.runExclusive(signal, (transaction) => transaction.write('new', signal))).rejects.toThrow();
    expect(files.get('/doompi/auth.tmp')).toBe('belongs to another operation');
    expect(directories.has('/doompi/auth.lock')).toBe(false);
  });
});
