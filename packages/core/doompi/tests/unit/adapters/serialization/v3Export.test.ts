import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { JsonlSessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportV4ToV3 } from '../../../../src/services/v3Export';
import type { HistoryOwnership } from '../../../../src/services/historyImport';

const CREATED_AT = Date.parse('2026-01-01T00:00:00.000Z');

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

async function upstreamJournal(
  root: string,
): Promise<{ path: string; rootId: string; mainTip: string; branchTip: string }> {
  const environment = new NodeExecutionEnv({ cwd: root });
  const repository = new JsonlSessionRepo({
    fileSystem: environment,
    sessionsRoot: root,
    now: () => CREATED_AT,
  });
  const session = await repository.create({ id: 'upstream-session', cwd: root }, BACKGROUND_CONTEXT);
  const message = (role: 'user' | 'assistant', text: string) =>
    ({ role, content: [{ type: 'text', text }] }) as Parameters<
      NonNullable<Awaited<ReturnType<typeof session.branch>>>['appendMessage']
    >[0];
  const main =
    (await session.branch('main', BACKGROUND_CONTEXT)) ??
    (await session.createBranch('main', null, BACKGROUND_CONTEXT));
  const rootEntry = await main.appendMessage(message('user', 'root'), BACKGROUND_CONTEXT);
  const mainTip = await main.appendMessage(message('assistant', 'main'), BACKGROUND_CONTEXT);
  const branch = await session.createBranch('side', rootEntry, BACKGROUND_CONTEXT);
  const branchTip = await branch.appendMessage(message('assistant', 'side'), BACKGROUND_CONTEXT);
  await session.setName('Upstream session', BACKGROUND_CONTEXT);
  await session.setLabel(mainTip, 'resume here', BACKGROUND_CONTEXT);
  await session.close(BACKGROUND_CONTEXT);
  const sessionPath = session.metadata.path;
  await repository.close(BACKGROUND_CONTEXT);
  await environment.cleanup(BACKGROUND_CONTEXT);
  return { path: sessionPath, rootId: rootEntry, mainTip, branchTip };
}

function records(filePath: string): Record<string, unknown>[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function v4Source(writes: readonly unknown[], header: Record<string, unknown> = {}): string {
  const baseHeader = {
    v: 4,
    kind: 'header',
    id: 'session-id',
    storageVersion: 1,
    createdAt: CREATED_AT,
    cwd: '/workspace',
  };
  return `${JSON.stringify({ ...baseHeader, ...header })}\n${writes.map((write) => JSON.stringify(write)).join('\n')}\n`;
}

function entryWrite(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'entry',
    id,
    parentId: null,
    seq: 1,
    timestamp: CREATED_AT + 1_000,
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: id }] },
    ...overrides,
  };
}

describe('protected v4 to v3 export', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-v3-export-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exports branches at the selected main tip and reports untimestamped native metadata without altering canonical bytes', async () => {
    const source = await upstreamJournal(root);
    const canonicalBytes = fs.readFileSync(source.path);
    const destinationPath = path.join(root, 'resume.jsonl');

    const result = await exportV4ToV3({ sourcePath: source.path, destinationPath, owner: owner() });
    const output = records(destinationPath);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8')) as {
      losses: { code: string; detail: string }[];
    };
    const outputIds = output.map((record) => record.id).filter((id): id is string => typeof id === 'string');

    expect(outputIds).toEqual(expect.arrayContaining([source.mainTip, source.branchTip]));
    expect(output.find((record) => record.id === source.mainTip)).toMatchObject({
      id: source.mainTip,
      parentId: source.rootId,
      timestamp: expect.any(String),
    });
    expect(output.find((record) => record.id === source.branchTip)).toMatchObject({
      id: source.branchTip,
      parentId: source.rootId,
      timestamp: expect.any(String),
    });
    expect(fs.readFileSync(source.path)).toEqual(canonicalBytes);
    expect(report).toMatchObject({
      version: 1,
      format: 'doompi-v4-to-v3-loss-report',
      sourcePath: source.path,
      destinationPath,
      sourceSha256: expect.any(String),
    });
    expect(report.losses.filter((loss) => loss.code === 'value-provenance')).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ value: 'Upstream session' }) }),
      expect.objectContaining({ record: expect.objectContaining({ key: source.mainTip, value: 'resume here' }) }),
    ]);
    expect(report.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'branch-tip-value' }),
        expect.objectContaining({ code: 'value-provenance' }),
      ]),
    );
  });

  it('holds ownership through publication, rejects concurrent owners, and resumes an interrupted publication', async () => {
    const source = await upstreamJournal(root);
    const destinationPath = path.join(root, 'resume.jsonl');
    const sharedOwner = owner();
    const heldLease = await sharedOwner.acquire(source.path);
    await expect(exportV4ToV3({ sourcePath: source.path, destinationPath, owner: sharedOwner })).rejects.toThrow(
      'history writer is already owned',
    );
    await heldLease.release();
    const realLink = fs.linkSync;
    let links = 0;
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      links += 1;
      if (links === 2) throw new Error('publication interrupted');
      return realLink(from, to);
    });

    await expect(exportV4ToV3({ sourcePath: source.path, destinationPath, owner: sharedOwner })).rejects.toThrow(
      'publication interrupted',
    );
    vi.restoreAllMocks();
    const resumed = await exportV4ToV3({ sourcePath: source.path, destinationPath, owner: sharedOwner });

    expect(resumed.status).toBe('published');
    expect(fs.existsSync(destinationPath)).toBe(true);
    expect(fs.existsSync(resumed.reportPath)).toBe(true);
  });

  it('fails closed on disk-full staging and preserves a file that wins an EEXIST race', async () => {
    const source = await upstreamJournal(root);
    const destinationPath = path.join(root, 'resume.jsonl');
    const realOpen = fs.openSync;
    let competingPath: string | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation((filePath, flags, mode) => {
      if (typeof filePath === 'string' && filePath.endsWith('.staging') && competingPath === undefined) {
        competingPath = filePath;
        fs.writeFileSync(filePath, 'another writer');
      }
      return realOpen(filePath, flags, mode);
    });

    await expect(exportV4ToV3({ sourcePath: source.path, destinationPath, owner: owner() })).rejects.toThrow();
    expect(competingPath).toBeDefined();
    expect(fs.readFileSync(competingPath!, 'utf8')).toBe('another writer');
    expect(fs.existsSync(destinationPath)).toBe(false);

    vi.restoreAllMocks();
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      if (typeof file === 'number') throw errorWithCode('ENOSPC');
      return realWrite(file, data, options);
    });
    await expect(exportV4ToV3({ sourcePath: source.path, destinationPath, owner: owner() })).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(fs.existsSync(destinationPath)).toBe(false);
    vi.restoreAllMocks();
    await expect(exportV4ToV3({ sourcePath: source.path, destinationPath, owner: owner() })).resolves.toMatchObject({
      status: 'published',
    });
  });

  it('rejects source mutation before publishing either derived file', async () => {
    const source = await upstreamJournal(root);
    const destinationPath = path.join(root, 'resume.jsonl');
    let checks = 0;
    const mutatingOwner: HistoryOwnership = {
      acquire: async () => ({
        assertQuiescent: () => {
          checks += 1;
          if (checks === 2) fs.appendFileSync(source.path, 'changed by writer\n');
        },
        release: vi.fn(),
      }),
    };

    await expect(exportV4ToV3({ sourcePath: source.path, destinationPath, owner: mutatingOwner })).rejects.toThrow(
      'source changed during export',
    );
    expect(fs.existsSync(destinationPath)).toBe(false);
  });

  it('does not resume over a destination changed after an interrupted publication', async () => {
    const source = await upstreamJournal(root);
    const destinationPath = path.join(root, 'resume.jsonl');
    const realLink = fs.linkSync;
    let links = 0;
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      links += 1;
      if (links === 2) throw new Error('publication interrupted');
      return realLink(from, to);
    });

    await expect(exportV4ToV3({ sourcePath: source.path, destinationPath, owner: owner() })).rejects.toThrow(
      'publication interrupted',
    );
    vi.restoreAllMocks();
    fs.appendFileSync(destinationPath, 'changed by another writer\n');

    await expect(exportV4ToV3({ sourcePath: source.path, destinationPath, owner: owner() })).rejects.toThrow(
      'does not match interrupted state',
    );
    expect(fs.readFileSync(destinationPath, 'utf8')).toContain('changed by another writer');
  });
  it('rejects malformed v4 input before staging any derived file', async () => {
    const cases: [string, string, RegExp | undefined][] = [
      ['empty', '', /Cannot export an empty v4 JSONL file/],
      ['malformed-header', 'not-json\n', undefined],
      ['wrong-header', `${JSON.stringify({ v: 3, kind: 'header' })}\n`, /Source is not v4 JSONL/],
      ['truncated', v4Source([]).trimEnd(), /Cannot export a truncated v4 JSONL file/],
      ['malformed-transaction', `${v4Source([]).trimEnd()}\nnot-json\n`, /Invalid v4 JSONL transaction at line 2/],
      ['invalid-header-id', v4Source([], { id: '' }), /Invalid v4 header id/],
      ['invalid-storage-version', v4Source([], { storageVersion: 0 }), /Invalid v4 storage version/],
      ['invalid-created-at', v4Source([], { createdAt: -1 }), /Invalid v4 header createdAt/],
      ['invalid-cwd', v4Source([], { cwd: '' }), /Invalid v4 header cwd/],
      ['invalid-parent-session-id', v4Source([], { parentSessionId: '' }), /Invalid v4 parent session id/],
      [
        'invalid-parent-session-path',
        v4Source([], { legacyParentSessionPath: '' }),
        /Invalid v4 legacy parent session path/,
      ],
    ];

    for (const [name, content, expectedError] of cases) {
      const sourcePath = path.join(root, `${name}.jsonl`);
      const destinationPath = path.join(root, `${name}.export.jsonl`);
      fs.writeFileSync(sourcePath, content);

      const exportPromise = exportV4ToV3({ sourcePath, destinationPath, owner: owner() });
      if (expectedError === undefined) await expect(exportPromise).rejects.toThrow();
      else await expect(exportPromise).rejects.toThrow(expectedError);
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(content);
      expect(fs.existsSync(destinationPath)).toBe(false);
      expect(fs.existsSync(`${destinationPath}.loss.json`)).toBe(false);
      expect(fs.existsSync(`${destinationPath}.export-state.json`)).toBe(false);
    }
  });

  it.each([
    ['entry', entryWrite('root', { seq: 0 }), /Invalid v4 entry sequence/],
    ['usage', { kind: 'usage', seq: 0, entryId: 'root', usage: {} }, /Invalid v4 usage sequence/],
    [
      'value',
      { kind: 'value', op: 'set', namespace: 'pi.test', key: 'key', seq: 0, value: true },
      /Invalid v4 value sequence/,
    ],
    [
      'list',
      { kind: 'list', op: 'append', namespace: 'pi.test', key: 'key', seq: 0, value: true },
      /Invalid v4 list sequence/,
    ],
  ])('rejects an invalid %s sequence before publication', async (_kind, write, expectedError) => {
    const sourcePath = path.join(root, 'invalid-sequence.jsonl');
    const destinationPath = path.join(root, 'invalid-sequence.export.jsonl');
    const source = v4Source([write]);
    fs.writeFileSync(sourcePath, source);

    await expect(exportV4ToV3({ sourcePath, destinationPath, owner: owner() })).rejects.toThrow(expectedError);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.existsSync(`${destinationPath}.loss.json`)).toBe(false);
  });

  it.each([
    ['duplicate entry ids', [entryWrite('same'), entryWrite('same', { seq: 2 })], /Duplicate v4 entry id/],
    ['missing entry parent', [entryWrite('child', { parentId: 'missing' })], /Missing v4 entry parent/],
    [
      'invalid branch summary source',
      [entryWrite('summary', { type: 'branch_summary', fromId: 42 })],
      /Invalid v4 branch summary source/,
    ],
    ['invalid custom entry type', [entryWrite('custom', { type: 'custom' })], /Invalid v4 custom entry type/],
  ])('rejects %s without publishing a partial export', async (_case, writes, expectedError) => {
    const sourcePath = path.join(root, 'invalid-entry.jsonl');
    const destinationPath = path.join(root, 'invalid-entry.export.jsonl');
    const source = v4Source(writes);
    fs.writeFileSync(sourcePath, source);

    await expect(exportV4ToV3({ sourcePath, destinationPath, owner: owner() })).rejects.toThrow(expectedError);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.existsSync(`${destinationPath}.loss.json`)).toBe(false);
    expect(fs.existsSync(`${destinationPath}.export-state.json`)).toBe(false);
  });

  it('reports non-object transactions and unsupported entries without writing those records', async () => {
    const sourcePath = path.join(root, 'losses.jsonl');
    const destinationPath = path.join(root, 'losses.export.jsonl');
    const source = v4Source([
      [
        42,
        entryWrite('future', { seq: 2, type: 'future_entry' }),
        { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'future', seq: 3 },
      ],
    ]);
    fs.writeFileSync(sourcePath, source);

    const result = await exportV4ToV3({ sourcePath, destinationPath, owner: owner() });
    const output = records(destinationPath);

    expect(output).toHaveLength(1);
    expect(result.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unknown-record', record: 42 }),
        expect.objectContaining({ code: 'entry-type', record: expect.objectContaining({ id: 'future' }) }),
        expect.objectContaining({ code: 'main-tip-not-representable' }),
      ]),
    );
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
  });

  it('reports each invalid native value independently while retaining valid entries', async () => {
    const sourcePath = path.join(root, 'invalid-values.jsonl');
    const destinationPath = path.join(root, 'invalid-values.export.jsonl');
    const source = v4Source([
      entryWrite('root'),
      { kind: 'value', op: 'set', namespace: 'pi.session.name', key: '', value: 42, seq: 2 },
      { kind: 'value', op: 'set', namespace: 'pi.session.name', key: 'extra', value: 'ignored', seq: 3 },
      { kind: 'value', op: 'set', namespace: 'pi.entry.label', key: 'root', value: 42, seq: 4 },
      { kind: 'value', op: 'set', namespace: 'pi.entry.label', key: 'missing', value: 'ignored', seq: 5 },
      { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 42, seq: 6 },
    ]);
    fs.writeFileSync(sourcePath, source);

    const result = await exportV4ToV3({ sourcePath, destinationPath, owner: owner() });
    const output = records(destinationPath);

    expect(output.find((record) => record.id === 'root')).toMatchObject({ type: 'message' });
    expect(output.some((record) => record.type === 'session_info' || record.type === 'label')).toBe(false);
    expect(result.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'session-name-value' }),
        expect.objectContaining({ code: 'session-name-key' }),
        expect.objectContaining({ code: 'label-value' }),
        expect.objectContaining({ code: 'label-target' }),
        expect.objectContaining({ code: 'main-tip-value' }),
      ]),
    );
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
  });

  it.each([
    ['missing', [entryWrite('root')], 'main-tip-missing'],
    [
      'non-leaf',
      [
        entryWrite('root'),
        entryWrite('child', { parentId: 'root', seq: 2 }),
        { kind: 'value', op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'root', seq: 3 },
      ],
      'main-tip-not-leaf',
    ],
  ])('reports a %s main tip instead of claiming an unsafe resume point', async (_case, writes, lossCode) => {
    const sourcePath = path.join(root, 'main-tip.jsonl');
    const destinationPath = path.join(root, 'main-tip.export.jsonl');
    const source = v4Source(writes);
    fs.writeFileSync(sourcePath, source);

    const result = await exportV4ToV3({ sourcePath, destinationPath, owner: owner() });

    expect(result.losses).toEqual(expect.arrayContaining([expect.objectContaining({ code: lossCode })]));
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(records(destinationPath).filter((record) => record.type === 'message')).toHaveLength(
      _case === 'missing' ? 1 : 2,
    );
  });
});
