import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileError, type Result } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/pi-agent-core/harness/context';
import { JsonlSessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHistoryCreationFileSystem } from '../../../../src/adapters/serialization/historyCreationFileSystem';
import {
  createHistoryOwnership,
  historyOwnershipLockPath,
} from '../../../../src/adapters/serialization/historyOwnership';
import type { HistoryOwnershipLease } from '../../../../src/adapters/serialization/historyImport';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(before?: (destination: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-create-history-'));
  roots.push(root);
  const backend = new NodeExecutionEnv({ cwd: root });
  const owner = createHistoryOwnership();
  let destination = '';
  let lease: HistoryOwnershipLease | undefined;
  const acquire = vi.fn(async (filePath: string) => {
    destination = filePath;
    if (before) await before(filePath);
    lease = await owner.acquire(filePath);
    await lease.assertQuiescent();
  });
  const fileSystem = createHistoryCreationFileSystem(backend, acquire);
  const repository = new JsonlSessionRepo({ fileSystem, sessionsRoot: root, now: () => 1_700_000_000_000 });
  return {
    root,
    backend,
    fileSystem,
    repository,
    acquire,
    get destination() {
      return destination;
    },
    create: () => repository.create({ id: 'new', cwd: root }, context),
    close: async () => {
      await repository.close(context);
      await backend.cleanup(context);
      await lease?.release();
    },
  };
}

const failure = () => ({ ok: false as const, error: new FileError('unknown', 'injected filesystem failure') });

function failedFileError<T>(result: Result<T, FileError>): FileError {
  if (result.ok) throw new Error('Expected filesystem operation to fail');
  return result.error;
}

describe('owned upstream history creation', () => {
  it('rejects a concurrent creator before publication without disturbing the first owner', async () => {
    const fixture = setup();
    let entered!: () => void;
    let resume!: () => void;
    const staging = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const originalWrite = fixture.backend.writeFile.bind(fixture.backend);
    vi.spyOn(fixture.backend, 'writeFile').mockImplementation(async (...args) => {
      entered();
      await proceed;
      return originalWrite(...args);
    });
    const secondBackend = new NodeExecutionEnv({ cwd: fixture.root });
    const secondFileSystem = createHistoryCreationFileSystem(secondBackend, async (destination) => {
      expect(destination).toBe(fixture.destination);
      const lease = await createHistoryOwnership().acquire(destination);
      await lease.release();
    });
    const second = new JsonlSessionRepo({
      fileSystem: secondFileSystem,
      sessionsRoot: fixture.root,
      now: () => 1_700_000_000_000,
    });
    const secondWrite = vi.spyOn(secondBackend, 'writeFile');
    const first = fixture.create();
    try {
      await staging;
      const lock = historyOwnershipLockPath(fixture.destination);
      const lockBytes = fs.readFileSync(lock);
      await expect(second.create({ id: 'new', cwd: fixture.root }, context)).rejects.toThrow('lock already exists');
      expect(secondWrite).not.toHaveBeenCalled();
      expect(fs.readFileSync(lock)).toEqual(lockBytes);
      resume();
      const session = await first;
      expect(JSON.parse(fs.readFileSync(session.metadata.path, 'utf8').split('\n')[0]!)).toMatchObject({
        kind: 'header',
        id: 'new',
      });
    } finally {
      resume();
      await (await first).close(context);
      await second.close(context);
      await secondBackend.cleanup(context);
      await fixture.close();
    }
  });

  it('holds the real canonical lease before the first write and keeps it after publication', async () => {
    const fixture = setup();
    const originalWrite = fixture.backend.writeFile.bind(fixture.backend);
    const writes = vi.spyOn(fixture.backend, 'writeFile').mockImplementation(async (...args) => {
      expect(fixture.acquire).toHaveBeenCalledOnce();
      expect(fs.existsSync(historyOwnershipLockPath(fixture.destination))).toBe(true);
      return originalWrite(...args);
    });
    try {
      const session = await fixture.create();
      expect(session.metadata.path).toBe(fixture.destination);
      expect(writes).toHaveBeenCalledOnce();
      await expect(createHistoryOwnership().acquire(fixture.destination)).rejects.toThrow('lock already exists');
      await session.close(context);
      expect(fixture.acquire).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
    expect(fs.existsSync(historyOwnershipLockPath(fixture.destination))).toBe(false);
  });

  it('never writes or removes history when ownership admission rejects', async () => {
    const fixture = setup(async () => {
      throw new Error('owner unavailable');
    });
    const write = vi.spyOn(fixture.backend, 'writeFile');
    const remove = vi.spyOn(fixture.backend, 'remove');
    try {
      await expect(fixture.create()).rejects.toThrow('owner unavailable');
      expect(write).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.destination)).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('preserves abandoned staging instead of overwriting it', async () => {
    const fixture = setup(async (destination) => {
      fs.writeFileSync(`${destination}.tmp`, 'abandoned');
    });
    const write = vi.spyOn(fixture.backend, 'writeFile');
    try {
      await expect(fixture.create()).rejects.toThrow('path is occupied');
      expect(write).not.toHaveBeenCalled();
      expect(fs.readFileSync(`${fixture.destination}.tmp`, 'utf8')).toBe('abandoned');
    } finally {
      await fixture.close();
    }
  });

  it('preserves ambiguous partial staging after a failed write', async () => {
    const fixture = setup();
    vi.spyOn(fixture.backend, 'writeFile').mockImplementation(async (filePath) => {
      fs.writeFileSync(filePath, 'partial');
      return failure();
    });
    const remove = vi.spyOn(fixture.backend, 'remove');
    try {
      await expect(fixture.create()).rejects.toThrow('injected filesystem failure');
      expect(remove).not.toHaveBeenCalled();
      expect(fs.readFileSync(`${fixture.destination}.tmp`, 'utf8')).toBe('partial');
      expect(fs.existsSync(fixture.destination)).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('removes only its successful staging when publication fails beside a foreign destination', async () => {
    const fixture = setup();
    vi.spyOn(fixture.backend, 'renameFile').mockImplementation(async (_source, destination) => {
      fs.writeFileSync(destination, 'foreign');
      return failure();
    });
    const remove = vi.spyOn(fixture.backend, 'remove');
    try {
      await expect(fixture.create()).rejects.toThrow('injected filesystem failure');
      expect(remove).toHaveBeenCalledExactlyOnceWith(
        `${fixture.destination}.tmp`,
        { force: true, recursive: false },
        context,
      );
      expect(fs.readFileSync(fixture.destination, 'utf8')).toBe('foreign');
    } finally {
      await fixture.close();
    }
  });

  it('allows cleanup of its own published file when metadata readback fails', async () => {
    const fixture = setup();
    vi.spyOn(fixture.fileSystem, 'fileInfo').mockResolvedValue(failure());
    const remove = vi.spyOn(fixture.backend, 'remove');
    try {
      await expect(fixture.create()).rejects.toThrow('injected filesystem failure');
      expect(remove).toHaveBeenCalledExactlyOnceWith(fixture.destination, { force: true, recursive: false }, context);
      expect(fs.existsSync(fixture.destination)).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('refuses mutation before admission and never recursively removes a directory', async () => {
    const fixture = setup();
    const remove = vi.spyOn(fixture.backend, 'remove');
    try {
      expect((await fixture.fileSystem.writeFile('unowned', 'data', context)).ok).toBe(false);
      expect((await fixture.fileSystem.appendFile('unowned', 'data', context)).ok).toBe(false);
      expect((await fixture.fileSystem.renameFile('unowned', 'other', context)).ok).toBe(false);
      expect((await fixture.fileSystem.remove(fixture.root, { recursive: true }, context)).ok).toBe(true);
      expect(remove).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  });

  it('converts backend exceptions and releases its lease during cleanup', async () => {
    const fixture = setup();
    let destination = '';
    try {
      const joined = await fixture.fileSystem.joinPath([fixture.root, 'exception.jsonl'], context);
      expect(joined.ok).toBe(true);
      destination = fixture.destination;
      const duplicate = await fixture.fileSystem.joinPath([fixture.root, 'exception.jsonl'], context);
      const duplicateError = failedFileError(duplicate);
      expect(duplicateError).toBeInstanceOf(FileError);
      expect(duplicateError.message).toContain('already selected');

      const write = vi.spyOn(fixture.backend, 'writeFile').mockRejectedValue(new Error('staging backend threw'));
      const failedWrite = await fixture.fileSystem.writeFile(`${destination}.tmp`, 'staging', context);
      const writeError = failedFileError(failedWrite);
      expect(writeError).toBeInstanceOf(FileError);
      expect(writeError.message).toBe('staging backend threw');
      write.mockRestore();
      expect((await fixture.fileSystem.writeFile(`${destination}.tmp`, 'staging', context)).ok).toBe(true);

      const rename = vi.spyOn(fixture.backend, 'renameFile').mockRejectedValue(new Error('publication backend threw'));
      const failedRename = await fixture.fileSystem.renameFile(`${destination}.tmp`, destination, context);
      const renameError = failedFileError(failedRename);
      expect(renameError).toBeInstanceOf(FileError);
      expect(renameError.message).toBe('publication backend threw');
      rename.mockRestore();
      expect((await fixture.fileSystem.renameFile(`${destination}.tmp`, destination, context)).ok).toBe(true);

      const append = vi.spyOn(fixture.backend, 'appendFile').mockRejectedValue(new Error('append backend threw'));
      const failedAppend = await fixture.fileSystem.appendFile(destination, 'append', context);
      const appendError = failedFileError(failedAppend);
      expect(appendError).toBeInstanceOf(FileError);
      expect(appendError.message).toBe('append backend threw');
      append.mockRestore();

      const remove = vi.spyOn(fixture.backend, 'remove').mockRejectedValue(new Error('remove backend threw'));
      const failedRemove = await fixture.fileSystem.remove(destination, { force: true }, context);
      const removeError = failedFileError(failedRemove);
      expect(removeError).toBeInstanceOf(FileError);
      expect(removeError.message).toBe('remove backend threw');
      expect(fs.existsSync(destination)).toBe(true);
      expect(fs.existsSync(historyOwnershipLockPath(destination))).toBe(true);
      remove.mockRestore();
    } finally {
      await fixture.close();
    }
    expect(fs.existsSync(historyOwnershipLockPath(destination))).toBe(false);
  });
});
