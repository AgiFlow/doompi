import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionLineagePath } from '@agimon-ai/doompi-web-contracts';
import { readSessionLineage } from '../../src/adapters/sessionLineage.ts';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  cleanups = [];
});

function freshRegistryDir(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-lineage-')), 'run');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  cleanups.push(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
}

function writeSidecar(registryDir: string, sessionId: string, raw: string): void {
  fs.writeFileSync(sessionLineagePath(registryDir, sessionId), raw, 'utf8');
}

describe('reading a session lineage sidecar', () => {
  it('reports no parent when no sidecar was ever written', () => {
    const registryDir = freshRegistryDir();

    expect(readSessionLineage(registryDir, 'lonely')).toBeUndefined();
  });

  it('reports no parent when the registry directory itself is absent', () => {
    const registryDir = path.join(os.tmpdir(), 'doompi-lineage-absent', String(Date.now()));

    expect(readSessionLineage(registryDir, 'lonely')).toBeUndefined();
  });

  it('reports no parent when the sidecar path cannot be read as a file', () => {
    const registryDir = freshRegistryDir();
    // A directory where the sidecar belongs makes readFileSync throw EISDIR,
    // which stands in for every unreadable-file failure the reader swallows.
    fs.mkdirSync(sessionLineagePath(registryDir, 'blocked'), { recursive: true });

    expect(readSessionLineage(registryDir, 'blocked')).toBeUndefined();
  });

  it('reports no parent for a torn write the spawning process left half-flushed', () => {
    const registryDir = freshRegistryDir();
    writeSidecar(registryDir, 'torn', '{"version":1,"parentSessionId":"roo');

    expect(readSessionLineage(registryDir, 'torn')).toBeUndefined();
  });

  it('reports no parent for a sidecar version this build predates', () => {
    const registryDir = freshRegistryDir();
    writeSidecar(
      registryDir,
      'future',
      JSON.stringify({ version: 2, parentSessionId: 'root', provenance: 'worktree' }),
    );

    expect(readSessionLineage(registryDir, 'future')).toBeUndefined();
  });

  it('returns the parent and provenance from a well-formed sidecar', () => {
    const registryDir = freshRegistryDir();
    writeSidecar(registryDir, 'child', JSON.stringify({ version: 1, parentSessionId: 'root', provenance: 'worktree' }));

    expect(readSessionLineage(registryDir, 'child')).toEqual({
      parentSessionId: 'root',
      provenance: 'worktree',
    });
  });

  it('drops the record version rather than leaking it to the rail', () => {
    const registryDir = freshRegistryDir();
    writeSidecar(registryDir, 'child', JSON.stringify({ version: 1, parentSessionId: 'root', provenance: 'worktree' }));

    expect(Object.keys(readSessionLineage(registryDir, 'child') ?? {}).sort()).toEqual([
      'parentSessionId',
      'provenance',
    ]);
  });

  it('reads each session id from its own sidecar', () => {
    const registryDir = freshRegistryDir();
    writeSidecar(registryDir, 'a', JSON.stringify({ version: 1, parentSessionId: 'root-a', provenance: 'worktree' }));
    writeSidecar(registryDir, 'b', JSON.stringify({ version: 1, parentSessionId: 'root-b', provenance: 'fork' }));

    expect(readSessionLineage(registryDir, 'a')?.parentSessionId).toBe('root-a');
    expect(readSessionLineage(registryDir, 'b')?.parentSessionId).toBe('root-b');
  });
});
