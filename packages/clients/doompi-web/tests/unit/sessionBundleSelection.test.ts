import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionBundleKey, sessionBundleSelection } from '../../src/adapters/sessionBundleSelection.ts';
import { parseSessionRecord } from '../../src/services/registryStore.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-session-selection-')));
  roots.push(root);
  const generationRoot = path.join(root, 'generations', 'new');
  const apiDirectory = path.join(root, 'generations', 'pinned', 'api');
  fs.mkdirSync(generationRoot, { recursive: true });
  fs.mkdirSync(apiDirectory, { recursive: true });
  const serverComposition = {
    root,
    apiDirectory,
    generation: 'pinned',
    fingerprint: 'a'.repeat(64),
    majorMode: 'review',
    activeLayers: ['core', 'source-control'],
  };
  return { root, registration: { root, generationRoot }, record: { serverComposition } };
}
describe('session-owned hub descriptor selection', () => {
  it('retains the session mode and previous pinned generation independently of new sync defaults', () => {
    const { record, registration } = fixture();
    expect(sessionBundleSelection(record, registration)).toEqual(record.serverComposition);
  });
  it('does not invent a current-mode selection for legacy records', () => {
    expect(sessionBundleSelection({}, fixture().registration)).toBeUndefined();
  });
  it('rejects another repository and a directory outside the admitted generation pool', () => {
    const first = fixture();
    const second = fixture();
    expect(() => sessionBundleSelection(first.record, second.registration)).toThrow(/another repository/);
    expect(() =>
      sessionBundleSelection(
        {
          serverComposition: {
            ...first.record.serverComposition,
            apiDirectory: second.record.serverComposition.apiDirectory,
          },
        },
        first.registration,
      ),
    ).toThrow(/escapes/);
  });
  it('rejects a generation symlink escaping the owning pool', () => {
    const first = fixture();
    const second = fixture();
    const link = path.join(first.root, 'generations', 'linked');
    fs.symlinkSync(path.dirname(second.record.serverComposition.apiDirectory), link);
    expect(() =>
      sessionBundleSelection(
        {
          serverComposition: {
            ...first.record.serverComposition,
            generation: 'linked',
            apiDirectory: path.join(link, 'api'),
          },
        },
        first.registration,
      ),
    ).toThrow(/escapes/);
  });
  it('keys separate selections separately and ignores layer ordering', () => {
    const { serverComposition } = fixture().record;
    expect(sessionBundleKey(serverComposition)).not.toBe(
      sessionBundleKey({ ...serverComposition, majorMode: 'build' }),
    );
    expect(sessionBundleKey(serverComposition)).toBe(
      sessionBundleKey({ ...serverComposition, activeLayers: [...serverComposition.activeLayers].reverse() }),
    );
  });
  it('preserves validated composition metadata and rejects malformed new records', () => {
    const { record } = fixture();
    const base = {
      version: 1,
      id: 'test',
      name: 'Test',
      cwd: '/repo',
      socketPath: '/socket',
      tokenFile: '/token',
      pid: 1,
      createdAt: '2026-01-01T00:00:00Z',
      ...record,
    };
    expect(parseSessionRecord(JSON.stringify(base))?.serverComposition).toEqual(record.serverComposition);
    expect(
      parseSessionRecord(
        JSON.stringify({ ...base, serverComposition: { ...record.serverComposition, activeLayers: [1] } }),
      ),
    ).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...base, serverComposition: null }))).toBeUndefined();
    expect(parseSessionRecord(JSON.stringify({ ...base, serverComposition: undefined }))).toBeDefined();
  });
});
