import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHistoryOwnership, historyOwnershipLockPath } from '../../src/adapters/serialization/historyOwnership.ts';
import { CliApp } from '../../src/commands/cli/cliApp.ts';
import { HistoryImportCommand } from '../../src/commands/historyImportCommand.ts';
import { routeCommand } from '../../src/commands/cli/router.ts';

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
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')
    .concat('\n');
}
const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const historyModule = path.join(packageDirectory, 'dist/history.mjs');
const cliModule = path.join(packageDirectory, 'dist/bin/cli.mjs');

function childResult(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForPath(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function interruptedImportScript(): string {
  return [
    "import fs from 'node:fs';",
    `import { createHistoryOwnership, protectAndImportHistory } from ${JSON.stringify(pathToFileURL(historyModule).href)};`,
    'const [sourcePath, destinationPath, markerPath] = process.argv.slice(1);',
    'await protectAndImportHistory({',
    '  sourcePath,',
    '  destinationPath,',
    "  owner: createHistoryOwnership({ sourceFormat: 'v3', additionalPaths: [destinationPath] }),",
    '  importStaging: async () => {',
    "    fs.writeFileSync(markerPath, 'entered');",
    '    await new Promise(() => setInterval(() => undefined, 1_000));',
    '  },',
    '});',
  ].join('\n');
}
function interruptedPublicationScript(): string {
  return [
    "import fs from 'node:fs';",
    `import { createHistoryOwnership, importV3WithPinnedUpstream, protectAndImportHistory } from ${JSON.stringify(pathToFileURL(historyModule).href)};`,
    'const [sourcePath, destinationPath, markerPath] = process.argv.slice(1);',
    'const unlink = fs.unlinkSync.bind(fs);',
    'fs.unlinkSync = (filePath) => {',
    "  if (String(filePath).endsWith('.staging')) {",
    "    fs.writeFileSync(markerPath, 'before-unlink');",
    "    process.kill(process.pid, 'SIGKILL');",
    '  }',
    '  return unlink(filePath);',
    '};',
    'await protectAndImportHistory({',
    '  sourcePath,',
    '  destinationPath,',
    "  owner: createHistoryOwnership({ sourceFormat: 'v3', additionalPaths: [destinationPath] }),",
    '  importStaging: importV3WithPinnedUpstream,',
    '});',
  ].join('\n');
}
function runHistoryImportCli(root: string, sourcePath: string, destinationPath: string) {
  return spawnSync(process.execPath, [cliModule, 'history-import', sourcePath, destinationPath, '--confirm-offline'], {
    cwd: root,
    encoding: 'utf8',
  });
}
describe('history-import CLI', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-history-import-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('recovers after a killed importer with explicit stale-lock cleanup', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    const originalPath = `${sourcePath}.original`;
    const statePath = `${destinationPath}.import-state.json`;
    const markerPath = path.join(root, 'import-staging-entered');
    const source = v3Source();
    fs.writeFileSync(sourcePath, source);
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', interruptedImportScript(), sourcePath, destinationPath, markerPath],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = childResult(child);
    try {
      await waitForPath(markerPath);
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'prepared' });
      expect(fs.readFileSync(originalPath, 'utf8')).toBe(source);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { stagingPath: string };
      expect(fs.readFileSync(state.stagingPath, 'utf8')).toBe(source);
      child.kill('SIGKILL');
      await expect(exited).resolves.toMatchObject({ signal: 'SIGKILL' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }

    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(true);
    expect(fs.existsSync(historyOwnershipLockPath(destinationPath))).toBe(true);
    const blocked = runHistoryImportCli(root, sourcePath, destinationPath);
    expect(blocked.status).toBe(1);
    expect(`${blocked.stdout}${blocked.stderr}`).toMatch(/lock|ambiguous/i);

    fs.rmSync(historyOwnershipLockPath(sourcePath));
    fs.rmSync(historyOwnershipLockPath(destinationPath));
    const resumed = runHistoryImportCli(root, sourcePath, destinationPath);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout.trim())).toMatchObject({ status: 'published' });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).phase).toBe('published');
    expect(JSON.parse(fs.readFileSync(destinationPath, 'utf8').split('\n')[0]!)).toMatchObject({
      kind: 'header',
      v: 4,
    });
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);

    const repeated = runHistoryImportCli(root, sourcePath, destinationPath);
    expect(repeated.status).toBe(0);
    expect(JSON.parse(repeated.stdout.trim())).toMatchObject({ status: 'already-published' });
  });

  it('recovers when publication is killed after destination linking', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    const originalPath = `${sourcePath}.original`;
    const statePath = `${destinationPath}.import-state.json`;
    const markerPath = path.join(root, 'before-publication-unlink');
    const source = v3Source();
    fs.writeFileSync(sourcePath, source);
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', interruptedPublicationScript(), sourcePath, destinationPath, markerPath],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = childResult(child);
    try {
      await expect(exited).resolves.toMatchObject({ signal: 'SIGKILL' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }

    expect(fs.existsSync(markerPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'verified' });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { stagingPath: string; stagedSha256: string };
    expect(fs.readFileSync(originalPath, 'utf8')).toBe(source);
    expect(fs.readFileSync(destinationPath)).toEqual(fs.readFileSync(state.stagingPath));
    expect(state.stagedSha256).toBeTruthy();
    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(true);
    expect(fs.existsSync(historyOwnershipLockPath(destinationPath))).toBe(true);

    fs.rmSync(historyOwnershipLockPath(sourcePath));
    fs.rmSync(historyOwnershipLockPath(destinationPath));
    const resumed = runHistoryImportCli(root, sourcePath, destinationPath);
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout.trim())).toMatchObject({ status: 'already-published' });
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).phase).toBe('published');
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
  });
  it('requires offline confirmation without mutating the source or sidecars', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    const source = v3Source();
    fs.writeFileSync(sourcePath, source);

    await expect(
      new HistoryImportCommand().execute(['history-import', sourcePath, destinationPath], {}, root),
    ).rejects.toThrow(/confirm-offline/i);

    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(fs.existsSync(`${sourcePath}.original`)).toBe(false);
    expect(fs.existsSync(`${destinationPath}.import-state.json`)).toBe(false);
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(false);
    expect(fs.existsSync(historyOwnershipLockPath(destinationPath))).toBe(false);
  });

  it('preserves the v3 source and publishes a distinct protected v4 copy', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    const source = v3Source();
    fs.writeFileSync(sourcePath, source);
    const output = { write: vi.fn() };

    await expect(
      new HistoryImportCommand().execute(
        ['history-import', 'legacy.jsonl', 'canonical.jsonl', '--confirm-offline'],
        {},
        root,
        output,
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(output.write.mock.calls[0]![0] as string) as {
      status: string;
      originalPath: string;
      destinationPath: string;
      statePath: string;
    };
    expect(result.status).toBe('published');
    expect(result.destinationPath).toBe(destinationPath);
    expect(result.originalPath).toBe(`${sourcePath}.original`);
    expect(result.statePath).toBe(`${destinationPath}.import-state.json`);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(fs.readFileSync(result.originalPath, 'utf8')).toBe(source);
    expect(JSON.parse(fs.readFileSync(destinationPath, 'utf8').split('\n')[0]!)).toMatchObject({
      kind: 'header',
      v: 4,
      id: 'session-id',
    });
    expect(JSON.parse(fs.readFileSync(result.statePath, 'utf8')).phase).toBe('published');
    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(false);
    expect(fs.existsSync(historyOwnershipLockPath(destinationPath))).toBe(false);
  });

  it('resumes a published import without running the pinned importer again', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    fs.writeFileSync(sourcePath, v3Source());
    const output = { write: vi.fn() };
    const command = new HistoryImportCommand();
    const args = ['history-import', sourcePath, destinationPath, '--confirm-offline'];

    await command.execute(args, {}, root, output);
    await expect(command.execute(args, {}, root, output)).resolves.toBe(0);

    expect(JSON.parse(output.write.mock.calls[1]![0] as string)).toMatchObject({ status: 'already-published' });
    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(false);
    expect(fs.existsSync(historyOwnershipLockPath(destinationPath))).toBe(false);
  });

  it('rejects an active source owner without disturbing that owner', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    fs.writeFileSync(sourcePath, v3Source());
    const sourceLease = await createHistoryOwnership({ sourceFormat: 'v3' }).acquire(sourcePath);
    try {
      await expect(
        new HistoryImportCommand().execute(
          ['history-import', sourcePath, destinationPath, '--confirm-offline'],
          {},
          root,
        ),
      ).rejects.toThrow(/already exists|ambiguous|lock/i);
      expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(true);
      expect(fs.existsSync(historyOwnershipLockPath(destinationPath))).toBe(false);
    } finally {
      await sourceLease.release();
    }
  });

  it('rejects an active destination owner and releases only its source lock', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    fs.writeFileSync(sourcePath, v3Source());
    const destinationLease = await createHistoryOwnership().acquire(destinationPath);
    try {
      await expect(
        new HistoryImportCommand().execute(
          ['history-import', sourcePath, destinationPath, '--confirm-offline'],
          {},
          root,
        ),
      ).rejects.toThrow(/already exists|ambiguous|lock/i);
      expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(false);
      expect(fs.existsSync(historyOwnershipLockPath(destinationPath))).toBe(true);
    } finally {
      await destinationLease.release();
    }
  });

  it('releases both owned locks when pinned import rejects', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    const source = `${v3Source()}${JSON.stringify({ type: 'unsupported', id: 'bad' })}\n`;
    fs.writeFileSync(sourcePath, source);

    await expect(
      new HistoryImportCommand().execute(
        ['history-import', sourcePath, destinationPath, '--confirm-offline'],
        {},
        root,
      ),
    ).rejects.toThrow(/Unsupported legacy v3 record type/i);

    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
    expect(fs.existsSync(`${sourcePath}.original`)).toBe(true);
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(false);
    expect(fs.existsSync(historyOwnershipLockPath(destinationPath))).toBe(false);
  });

  it('requires an independent regular v3 source file', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const aliasPath = path.join(root, 'legacy-alias.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    fs.writeFileSync(sourcePath, v3Source());
    fs.linkSync(sourcePath, aliasPath);

    await expect(
      new HistoryImportCommand().execute(['history-import', aliasPath, destinationPath, '--confirm-offline'], {}, root),
    ).rejects.toThrow(/independent regular file/i);

    expect(fs.existsSync(`${aliasPath}.original`)).toBe(false);
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(false);
    expect(fs.existsSync(historyOwnershipLockPath(destinationPath))).toBe(false);
  });

  it('rejects an ambiguous destination lock without reclaiming it', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    const destinationPath = path.join(root, 'canonical.jsonl');
    fs.writeFileSync(sourcePath, v3Source());
    const destinationLock = historyOwnershipLockPath(destinationPath);
    fs.writeFileSync(destinationLock, '{not-json');

    await expect(
      new HistoryImportCommand().execute(
        ['history-import', sourcePath, destinationPath, '--confirm-offline'],
        {},
        root,
      ),
    ).rejects.toThrow(/lock|ambiguous/i);

    expect(fs.readFileSync(destinationLock, 'utf8')).toBe('{not-json');
    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(false);
  });
  it('registers history-import without preparing the harness and serves command help', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(routeCommand(['history-import', '--help'])).toBe('history-import');
    await expect(new CliApp().run(['history-import', '--help'])).resolves.toBe(0);
    expect(write.mock.calls.flat().join('')).toContain('Usage: doompi history-import');
  });
});
