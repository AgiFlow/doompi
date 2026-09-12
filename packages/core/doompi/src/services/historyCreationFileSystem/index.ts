import { FileError, type FileSystem, type Result } from '@earendil-works/pi-agent-core';

function rejected(error: unknown, filePath?: string): Result<never, FileError> {
  return {
    ok: false,
    error: new FileError(
      'unknown',
      error instanceof Error ? error.message : String(error),
      filePath,
      error instanceof Error ? error : undefined,
    ),
  };
}

/**
 * Own the destination before pinned JsonlSessionRepo computes its final path.
 * Storage remains upstream-owned. Only acquisition and destructive cleanup are gated.
 * Pinned 0.85.1 stages at destination + '.tmp'; an unexpected write fails closed.
 */
export function createHistoryCreationFileSystem(
  backend: FileSystem,
  beforeCreate: (destinationPath: string) => Promise<void>,
): FileSystem {
  let destination: string | undefined;
  let staging: string | undefined;
  let admitted = false;
  let stagingWritten = false;
  let published = false;
  return {
    cwd: backend.cwd,
    absolutePath: backend.absolutePath.bind(backend),
    readTextFile: backend.readTextFile.bind(backend),
    readTextLines: backend.readTextLines.bind(backend),
    readBinaryFile: backend.readBinaryFile.bind(backend),
    async appendFile(filePath, content, context) {
      try {
        if (!admitted || !published || filePath !== destination)
          return rejected(new Error('Unowned history append'), filePath);
        return await backend.appendFile(filePath, content, context);
      } catch (error) {
        return rejected(error, filePath);
      }
    },
    fileInfo: backend.fileInfo.bind(backend),
    listDir: backend.listDir.bind(backend),
    canonicalPath: backend.canonicalPath.bind(backend),
    exists: backend.exists.bind(backend),
    createDir: backend.createDir.bind(backend),
    createTempDir: backend.createTempDir.bind(backend),
    createTempFile: backend.createTempFile.bind(backend),
    cleanup: backend.cleanup.bind(backend),
    async joinPath(parts, context) {
      try {
        const result = await backend.joinPath(parts, context);
        if (!result.ok || !result.value.endsWith('.jsonl')) return result;
        if (destination !== undefined) {
          return rejected(new Error('History creation destination was already selected'), result.value);
        }
        destination = result.value;
        staging = `${destination}.tmp`;
        const existing = await backend.exists(destination, context);
        if (!existing.ok) return existing;
        if (existing.value) return rejected(new Error('Refusing to replace existing history'), destination);
        await beforeCreate(destination);
        // Recheck after acquiring the lease, including abandoned upstream staging.
        for (const filePath of [destination, staging]) {
          const found = await backend.exists(filePath, context);
          if (!found.ok) return found;
          if (found.value) return rejected(new Error('History creation path is occupied'), filePath);
        }
        admitted = true;
        return result;
      } catch (error) {
        return rejected(error, destination);
      }
    },
    async writeFile(filePath, content, context) {
      try {
        if (!admitted || filePath !== staging || stagingWritten) {
          return rejected(new Error('Unowned history staging write'), filePath);
        }
        const existing = await backend.exists(filePath, context);
        if (!existing.ok) return existing;
        if (existing.value) return rejected(new Error('History staging path is occupied'), filePath);
        const result = await backend.writeFile(filePath, content, context);
        if (result.ok) stagingWritten = true;
        return result;
      } catch (error) {
        return rejected(error, filePath);
      }
    },
    async renameFile(sourcePath, destinationPath, context) {
      try {
        if (!admitted || sourcePath !== staging || destinationPath !== destination || !stagingWritten) {
          return rejected(new Error('Unowned history publication'), destinationPath);
        }
        const result = await backend.renameFile(sourcePath, destinationPath, context);
        if (result.ok) {
          published = true;
          stagingWritten = false;
        }
        return result;
      } catch (error) {
        return rejected(error, destinationPath);
      }
    },
    async remove(filePath, options, context) {
      try {
        const owned = (filePath === staging && stagingWritten) || (filePath === destination && published);
        // Upstream calls remove even when creation failed before owning either file.
        if (!owned) return { ok: true, value: undefined };
        const result = await backend.remove(filePath, { ...options, recursive: false }, context);
        if (result.ok) {
          if (filePath === staging) stagingWritten = false;
          if (filePath === destination) published = false;
        }
        return result;
      } catch (error) {
        return rejected(error, filePath);
      }
    },
  };
}
