import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  protectAndImportHistory,
  restoreProtectedHistory,
  type HistoryStagingImportInput,
  type HistoryOwnership,
} from '../../../../src/adapters/serialization/historyImport';
import { exportV4ToV3 } from '../../../../src/adapters/serialization/v3Export';

import { importV3WithPinnedUpstream } from '../../../../src/adapters/serialization/jsonlSessionRepo';

function owner(): HistoryOwnership {
  let held = false;
  return {
    acquire: vi.fn(async () => {
      if (held) throw new Error('history writer is already owned');
      held = true;
      return {
        assertQuiescent: vi.fn(),
        release: vi.fn(async () => {
          held = false;
        }),
      };
    }),
  };
}

function v3Source(): string {
  return [
    {
      type: 'session',
      version: 3,
      id: 'session-id',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/workspace',
    },
    {
      type: 'message',
      id: 'root',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    },
    {
      type: 'message',
      id: 'child',
      parentId: 'root',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    },
    {
      type: 'custom',
      id: 'custom',
      parentId: 'root',
      timestamp: '2026-01-01T00:00:03.000Z',
      customType: 'extension-state',
      data: { retained: true },
    },
    {
      type: 'label',
      id: 'label-record',
      parentId: 'child',
      timestamp: '2026-01-01T00:00:04.000Z',
      targetId: 'child',
      label: 'bookmark',
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')
    .concat('\n');
}

function v4Source(): string {
  const header = {
    v: 4,
    kind: 'header',
    id: 'session-id',
    storageVersion: 1,
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    cwd: '/workspace',
  };
  const writes = [
    {
      kind: 'entry',
      id: 'root',
      parentId: null,
      seq: 1,
      timestamp: Date.parse('2026-01-01T00:00:01.000Z'),
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    },
    {
      kind: 'entry',
      id: 'child',
      parentId: 'root',
      seq: 2,
      timestamp: Date.parse('2026-01-01T00:00:02.000Z'),
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
      extensionField: { preserved: true },
    },
    {
      kind: 'entry',
      id: 'custom',
      parentId: 'root',
      seq: 3,
      timestamp: Date.parse('2026-01-01T00:00:03.000Z'),
      type: 'custom',
      customType: 'extension-state',
      data: { retained: true },
    },
    {
      kind: 'usage',
      id: 'usage-id',
      entryId: 'child',
      seq: 4,
      usage: { input: 10, output: 4, totalTokens: 14 },
      adjustment: false,
    },
    { kind: 'value', op: 'set', namespace: 'pi.session.name', key: '', seq: 5, value: 'A session' },
    { kind: 'value', op: 'set', namespace: 'pi.entry.label', key: 'child', seq: 6, value: 'bookmark' },
    { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', seq: 7, value: 'child' },
    { kind: 'value', op: 'set', namespace: 'pi.future.value', key: 'x', seq: 8, value: true },
    { kind: 'list', op: 'append', namespace: 'pi.future.list', key: 'x', seq: 9, value: { future: true } },
    { kind: 'future-write', seq: 10, data: { future: true } },
    { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'alternate', seq: 11, value: 'custom' },
  ];
  return `${JSON.stringify(header)}\n${writes.map((write) => JSON.stringify(write)).join('\n')}\n`;
}

describe('protected history import', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-history-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('backs up exact bytes, imports a staging copy, verifies mappings, and publishes atomically', async () => {
    const sourcePath = path.join(root, 'source.jsonl');
    const destinationPath = path.join(root, 'imported.jsonl');
    const originalPath = path.join(root, 'source.original');
    const statePath = path.join(root, 'import.state.json');
    const source = v3Source();
    fs.writeFileSync(sourcePath, source, { mode: 0o600 });
    const importStaging = vi.fn(async (input: HistoryStagingImportInput) => {
      expect(input.stagingPath).not.toBe(sourcePath);
      return importV3WithPinnedUpstream(input);
    });

    const result = await protectAndImportHistory({
      sourcePath,
      destinationPath,
      originalPath,
      statePath,
      owner: owner(),
      importStaging,
    });

    expect(result.status).toBe('published');
    expect(importStaging).toHaveBeenCalledOnce();
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(fs.readFileSync(originalPath, 'utf8')).toBe(source);
    expect(JSON.parse(fs.readFileSync(destinationPath, 'utf8').split('\n')[0]!)).toMatchObject({
      v: 4,
      kind: 'header',
      id: 'session-id',
    });
    expect(result.verification.entries.length).toBeGreaterThan(0);
    expect(fs.statSync(originalPath).mode & 0o077).toBe(0);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).phase).toBe('published');

    const resumed = await protectAndImportHistory({
      sourcePath,
      destinationPath,
      originalPath,
      statePath,
      owner: owner(),
      importStaging,
    });
    expect(resumed.status).toBe('already-published');
    expect(importStaging).toHaveBeenCalledOnce();
  });

  it('rejects concurrent ownership and keeps an interrupted preparation resumable', async () => {
    const sourcePath = path.join(root, 'source.jsonl');
    const destinationPath = path.join(root, 'imported.jsonl');
    const sharedOwner = owner();
    fs.writeFileSync(sourcePath, v3Source());
    let fail = true;
    const importStaging = vi.fn(async (input: HistoryStagingImportInput) => {
      if (fail) {
        fail = false;
        throw new Error('staging interrupted');
      }
      return importV3WithPinnedUpstream(input);
    });
    const options = { sourcePath, destinationPath, owner: sharedOwner, importStaging };

    await expect(protectAndImportHistory(options)).rejects.toThrow('staging interrupted');
    const concurrent = await Promise.allSettled([protectAndImportHistory(options), protectAndImportHistory(options)]);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(concurrent.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.objectContaining({ message: 'history writer is already owned' }),
    });
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(v3Source());
    expect(JSON.parse(fs.readFileSync(destinationPath, 'utf8').split('\n')[0]!)).toMatchObject({ v: 4 });
  });

  it('restores the protected original after a source replacement and rejects changed sources', async () => {
    const sourcePath = path.join(root, 'source.jsonl');
    const destinationPath = path.join(root, 'imported.jsonl');
    const originalPath = path.join(root, 'source.original');
    const source = v3Source();
    fs.writeFileSync(sourcePath, source);
    const importStaging = vi.fn(async (input: HistoryStagingImportInput) => {
      const verification = await importV3WithPinnedUpstream(input);
      fs.writeFileSync(sourcePath, 'unmanaged replacement');
      return verification;
    });

    await expect(
      protectAndImportHistory({ sourcePath, destinationPath, originalPath, owner: owner(), importStaging }),
    ).rejects.toThrow('source changed during import');
    expect(fs.readFileSync(originalPath, 'utf8')).toBe(source);
    await restoreProtectedHistory({ sourcePath, originalPath, owner: owner() });
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
  });

  it('preserves unknown original records when upstream refuses their import', async () => {
    const sourcePath = path.join(root, 'unknown.jsonl');
    const destinationPath = path.join(root, 'imported.jsonl');
    const originalPath = path.join(root, 'unknown.original');
    const source =
      v3Source() +
      JSON.stringify({
        type: 'unknown_future_record',
        id: 'unknown',
        parentId: 'custom',
        timestamp: '2026-01-01T00:00:05.000Z',
        payload: { retained: true },
      }) +
      '\n';
    fs.writeFileSync(sourcePath, source);
    await expect(
      protectAndImportHistory({
        sourcePath,
        destinationPath,
        originalPath,
        owner: owner(),
        importStaging: importV3WithPinnedUpstream,
      }),
    ).rejects.toThrow(/Unsupported legacy v3 record type/);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(fs.readFileSync(originalPath, 'utf8')).toBe(source);
    expect(fs.existsSync(destinationPath)).toBe(false);
  });

  it('never removes a file that wins an exclusive-backup creation race', async () => {
    const sourcePath = path.join(root, 'source.jsonl');
    const destinationPath = path.join(root, 'imported.jsonl');
    const originalPath = path.join(root, 'backup.original');
    fs.writeFileSync(sourcePath, v3Source());
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (file === originalPath && flags === 'wx') fs.writeFileSync(originalPath, 'another owner');
      return realOpen(file, flags, mode);
    });
    await expect(
      protectAndImportHistory({
        sourcePath,
        destinationPath,
        originalPath,
        owner: owner(),
        importStaging: importV3WithPinnedUpstream,
      }),
    ).rejects.toThrow();
    expect(fs.readFileSync(originalPath, 'utf8')).toBe('another owner');
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(v3Source());
    expect(fs.existsSync(destinationPath)).toBe(false);
  });

  it('imports a header-only session without inventing conversation entries', async () => {
    const sourcePath = path.join(root, 'empty.jsonl');
    const destinationPath = path.join(root, 'empty-v4.jsonl');
    const source = v3Source().split('\n')[0] + '\n';
    fs.writeFileSync(sourcePath, source);
    const result = await protectAndImportHistory({
      sourcePath,
      destinationPath,
      owner: owner(),
      importStaging: importV3WithPinnedUpstream,
    });
    expect(result.verification.entries).toEqual([]);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(JSON.parse(fs.readFileSync(destinationPath, 'utf8').split('\n')[0]!)).toMatchObject({ v: 4 });
  });

  it('rejects a published journal changed after import rather than accepting stale proof', async () => {
    const sourcePath = path.join(root, 'source.jsonl');
    const destinationPath = path.join(root, 'imported.jsonl');
    fs.writeFileSync(sourcePath, v3Source());
    const options = { sourcePath, destinationPath, owner: owner(), importStaging: importV3WithPinnedUpstream };
    await protectAndImportHistory(options);
    fs.appendFileSync(destinationPath, 'external writer\n');
    await expect(protectAndImportHistory(options)).rejects.toThrow(/destination was modified/);
    expect(fs.readFileSync(destinationPath, 'utf8')).toContain('external writer');
  });

  it.each(['timestamp', 'session identity', 'label'])(
    'rejects changed %s even with unchanged content hashes',
    async (field) => {
      const sourcePath = path.join(root, 'source.jsonl');
      const destinationPath = path.join(root, 'imported.jsonl');
      fs.writeFileSync(sourcePath, v3Source());
      await expect(
        protectAndImportHistory({
          sourcePath,
          destinationPath,
          owner: owner(),
          importStaging: async (input) => {
            const verification = await importV3WithPinnedUpstream(input);
            const rows = fs
              .readFileSync(input.stagingPath, 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as Record<string, unknown> | Record<string, unknown>[]);
            if (field === 'timestamp') {
              const entry = rows.flat().find((record) => record.kind === 'entry');
              if (!entry) throw new Error('fixture has no imported entry');
              entry.timestamp = 0;
            } else if (field === 'label') {
              const label = rows.flat().find((record) => record.namespace === 'pi.entry.label');
              if (!label) throw new Error('fixture has no imported label');
              label.value = 'changed label';
            } else {
              const header = rows[0] as Record<string, unknown>;
              header.id = 'wrong-session';
            }
            fs.writeFileSync(input.stagingPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
            return verification;
          },
        }),
      ).rejects.toThrow(/timestamp|identity|label/);
      expect(fs.existsSync(destinationPath)).toBe(false);
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(v3Source());
    },
  );

  it('rejects proof that omits retained source entries', async () => {
    const sourcePath = path.join(root, 'source.jsonl');
    const destinationPath = path.join(root, 'imported.jsonl');
    fs.writeFileSync(sourcePath, v3Source());
    await expect(
      protectAndImportHistory({
        sourcePath,
        destinationPath,
        owner: owner(),
        importStaging: async (input) => {
          const verification = await importV3WithPinnedUpstream(input);
          return { ...verification, entries: verification.entries.slice(1) };
        },
      }),
    ).rejects.toThrow(/proof|mapping|entry|entries/i);
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(v3Source());
  });

  it('keeps exact originals and does not publish after an injected staging disk-full failure', async () => {
    const sourcePath = path.join(root, 'source.jsonl');
    const destinationPath = path.join(root, 'imported.jsonl');
    const originalPath = path.join(root, 'backup.original');
    fs.writeFileSync(sourcePath, v3Source());
    const failure = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    const options = {
      sourcePath,
      destinationPath,
      originalPath,
      owner: owner(),
      importStaging: importV3WithPinnedUpstream,
    };
    await expect(
      protectAndImportHistory({
        ...options,
        importStaging: (input) => {
          fs.appendFileSync(input.stagingPath, '{"partial":');
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(v3Source());
    expect(fs.readFileSync(originalPath, 'utf8')).toBe(v3Source());
    await expect(protectAndImportHistory(options)).resolves.toMatchObject({ status: 'published' });
  });

  it('rejects a pre-existing derived destination instead of overwriting it', async () => {
    const sourcePath = path.join(root, 'source.jsonl');
    const destinationPath = path.join(root, 'imported.jsonl');
    fs.writeFileSync(sourcePath, v3Source());
    fs.writeFileSync(destinationPath, 'unrelated');
    await expect(
      protectAndImportHistory({
        sourcePath,
        destinationPath,
        owner: owner(),
        importStaging: importV3WithPinnedUpstream,
      }),
    ).rejects.toThrow('overwrite derived history');
    expect(fs.readFileSync(destinationPath, 'utf8')).toBe('unrelated');
  });
});

describe('v4 to v3 export', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-export-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exports empty and branching metadata/custom history deterministically with a loss report', async () => {
    const sourcePath = path.join(root, 'canonical.jsonl');
    const destinationPath = path.join(root, 'resume.jsonl');
    fs.writeFileSync(sourcePath, v4Source());
    const result = await exportV4ToV3({ sourcePath, destinationPath, owner: owner() });
    const records = fs
      .readFileSync(destinationPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8')) as { losses: { code: string }[] };

    expect(records[0]).toMatchObject({ type: 'session', version: 3, id: 'session-id', cwd: '/workspace' });
    expect(records.find((record) => record.id === 'child')).toMatchObject({ parentId: 'root', type: 'message' });
    expect(records.find((record) => record.id === 'child')).toMatchObject({
      message: { usage: { input: 10, output: 4, totalTokens: 14 } },
    });
    expect(records.find((record) => record.type === 'custom')).toMatchObject({ customType: 'extension-state' });
    expect(records.find((record) => record.type === 'session_info')).toBeUndefined();
    expect(records.find((record) => record.type === 'label')).toBeUndefined();
    expect(report.losses.map((loss) => loss.code)).toEqual(
      expect.arrayContaining([
        'branch-tip-value',
        'value-not-representable',
        'list-not-representable',
        'unknown-write',
      ]),
    );
    expect(report.losses.filter((loss) => loss.code === 'branch-tip-value')).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ key: 'alternate', value: 'custom' }) }),
    ]);
    expect(result.status).toBe('published');

    const secondDestination = path.join(root, 'resume-again.jsonl');
    await exportV4ToV3({ sourcePath, destinationPath: secondDestination, owner: owner() });
    expect(fs.readFileSync(destinationPath, 'utf8')).toBe(fs.readFileSync(secondDestination, 'utf8'));
  });

  it('preserves original v3 label timestamps and mapped branch relationships through protected import and export', async () => {
    const sourcePath = path.join(root, 'original-v3.jsonl');
    const canonicalPath = path.join(root, 'canonical-v4.jsonl');
    const exportedPath = path.join(root, 'exported-v3.jsonl');
    fs.writeFileSync(sourcePath, v3Source());
    await protectAndImportHistory({ sourcePath, destinationPath: canonicalPath, owner: owner() });
    await exportV4ToV3({ sourcePath: canonicalPath, destinationPath: exportedPath, owner: owner() });
    const records = fs
      .readFileSync(exportedPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const child = records.find((record) => record.type === 'message' && record.message.role === 'assistant');
    expect(child).toBeDefined();
    expect(records.find((record) => record.type === 'label')).toMatchObject({
      id: expect.any(String),
      targetId: child.id,
      label: 'bookmark',
      parentId: child.id,
      timestamp: '2026-01-01T00:00:04.000Z',
    });
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(v3Source());
  });

  it('exports a header-only v4 session as an empty v3 history', async () => {
    const sourcePath = path.join(root, 'canonical.jsonl');
    const destinationPath = path.join(root, 'empty.jsonl');
    fs.writeFileSync(sourcePath, `${v4Source().split('\n', 1)[0]}\n`);

    const result = await exportV4ToV3({ sourcePath, destinationPath, owner: owner() });

    expect(fs.readFileSync(destinationPath, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    expect(result.losses).toEqual([]);
    expect(JSON.parse(fs.readFileSync(result.reportPath, 'utf8')).losses).toEqual([]);
  });

  it('cleans staged files when a derived write fails before publication', async () => {
    const sourcePath = path.join(root, 'canonical.jsonl');
    const destinationPath = path.join(root, 'write-failure.jsonl');
    fs.writeFileSync(sourcePath, v4Source());
    const realOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, mode) => {
      if (typeof filePath === 'string' && filePath.endsWith('.staging')) throw new Error('derived write failed');
      return realOpen(filePath, flags, mode);
    });

    await expect(async () => exportV4ToV3({ sourcePath, destinationPath, owner: owner() })).rejects.toThrow(
      'derived write failed',
    );
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.existsSync(`${destinationPath}.loss.json`)).toBe(false);
  });

  it('recovers a publication interrupted between the distinct export files', async () => {
    const sourcePath = path.join(root, 'canonical.jsonl');
    const destinationPath = path.join(root, 'resume.jsonl');
    fs.writeFileSync(sourcePath, v4Source());
    const realLink = fs.linkSync;
    let calls = 0;
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      calls += 1;
      if (calls === 2) throw new Error('publication interrupted');
      return realLink(source, destination);
    });
    await expect(async () => exportV4ToV3({ sourcePath, destinationPath, owner: owner() })).rejects.toThrow(
      'publication interrupted',
    );
    vi.restoreAllMocks();

    const resumed = await exportV4ToV3({ sourcePath, destinationPath, owner: owner() });
    expect(resumed.status).toBe('published');
    expect(fs.existsSync(destinationPath)).toBe(true);
    expect(fs.existsSync(resumed.reportPath)).toBe(true);
  });

  it('rejects truncation and never overwrites an existing derived file', async () => {
    const sourcePath = path.join(root, 'canonical.jsonl');
    const destinationPath = path.join(root, 'resume.jsonl');
    fs.writeFileSync(sourcePath, v4Source().slice(0, -1));
    await expect(async () => exportV4ToV3({ sourcePath, destinationPath, owner: owner() })).rejects.toThrow(
      'truncated',
    );
    expect(fs.existsSync(destinationPath)).toBe(false);

    fs.writeFileSync(sourcePath, v4Source());
    fs.writeFileSync(destinationPath, 'existing');
    await expect(async () => exportV4ToV3({ sourcePath, destinationPath, owner: owner() })).rejects.toThrow(
      'overwrite',
    );
    expect(fs.readFileSync(destinationPath, 'utf8')).toBe('existing');
  });
});
