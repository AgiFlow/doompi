import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { JsonlSessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportV4ToV3 } from '../../../../src/adapters/serialization/v3Export';
import type { HistoryOwnership } from '../../../../src/adapters/serialization/historyImport';

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

async function upstreamJournal(root: string): Promise<{ path: string; mainTip: string; branchTip: string }> {
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
  return { path: sessionPath, mainTip, branchTip };
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

describe('protected v4 to v3 export', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-v3-export-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exports an upstream journal with every branch and resumes at the selected main tip', async () => {
    const source = await upstreamJournal(root);
    const destinationPath = path.join(root, 'resume.jsonl');

    const result = await exportV4ToV3({ sourcePath: source.path, destinationPath, owner: owner() });
    const output = records(destinationPath);
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf8')) as {
      losses: { code: string; detail: string }[];
    };
    const outputIds = output.map((record) => record.id).filter((id): id is string => typeof id === 'string');

    expect(outputIds).toEqual(expect.arrayContaining([source.mainTip, source.branchTip]));
    expect(output.filter((record) => record.type === 'message').at(-1)?.id).toBe(source.mainTip);
    expect(output.find((record) => record.type === 'session_info')).toMatchObject({ name: 'Upstream session' });
    expect(output.find((record) => record.type === 'label')).toMatchObject({
      targetId: source.mainTip,
      label: 'resume here',
    });
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
});
