import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readSessionCatalogSnapshot,
  sessionCatalogPathFor,
  writeSessionCatalogSnapshot,
} from '../../src/adapters/sessionCatalogSnapshot.ts';

const SESSION = `catalog-snap-${String(process.pid)}-${String(Date.now())}`;

const pathFor = (sessionId: string): string => {
  const target = sessionCatalogPathFor({ sessionId, tmpdir: os.tmpdir(), uid: process.getuid?.() });
  if (target === undefined) throw new Error('This platform has no uid; the snapshot bridge is disabled.');
  return target;
};

const read = (sessionId: string): ReturnType<typeof readSessionCatalogSnapshot> =>
  readSessionCatalogSnapshot({ sessionId, tmpdir: os.tmpdir(), uid: process.getuid?.() });

afterEach(() => {
  fs.rmSync(path.dirname(pathFor(SESSION)), { recursive: true, force: true });
});

describe('the session catalog snapshot bridge', () => {
  it('round-trips what the session published', () => {
    writeSessionCatalogSnapshot(SESSION, {
      cwd: '/workspace',
      agents: [{ name: 'reviewer', source: 'plugin', description: 'reviews', filePath: '/p/reviewer.md' }],
      models: ['anthropic/claude'],
    });

    const snapshot = read(SESSION);
    expect(snapshot?.cwd).toBe('/workspace');
    expect(snapshot?.agents.map((entry) => entry.name)).toEqual(['reviewer']);
    expect(snapshot?.models).toEqual(['anthropic/claude']);
    expect(Number.isNaN(Date.parse(snapshot?.updatedAt ?? ''))).toBe(false);
  });

  it('leaves no temporary file behind', () => {
    writeSessionCatalogSnapshot(SESSION, { cwd: '/workspace', agents: [], models: [] });
    const directory = path.dirname(pathFor(SESSION));
    expect(fs.readdirSync(directory)).toEqual(['catalog.json']);
  });

  it('reports nothing for a session that never published', () => {
    expect(read(`${SESSION}-absent`)).toBeUndefined();
  });

  it('rejects an unreadable, foreign-version or malformed file', () => {
    const target = pathFor(SESSION);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    fs.writeFileSync(target, 'not json');
    expect(read(SESSION)).toBeUndefined();

    fs.writeFileSync(target, JSON.stringify({ version: 99, cwd: '/w', agents: [], models: [], updatedAt: 'now' }));
    expect(read(SESSION)).toBeUndefined();

    fs.writeFileSync(
      target,
      JSON.stringify({ version: 1, cwd: '/w', updatedAt: 'now', models: [], agents: [{ name: 'x' }] }),
    );
    expect(read(SESSION)).toBeUndefined();
  });
});
