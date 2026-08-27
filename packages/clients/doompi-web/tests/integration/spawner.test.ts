import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServerSpawner } from '../../src/adapters/serverSpawner.ts';

/**
 * A stand-in doompi-server executable: parses the flags the spawner passes,
 * writes its registry record like the real bin would, and stays alive.
 */
const REGISTERING_SERVER = `#!/usr/bin/env node
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(value('--registry-dir'), 'sessions');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, value('--session-id') + '.json'), JSON.stringify({
  version: 1,
  id: value('--session-id'),
  name: value('--name'),
  cwd: process.cwd(),
  socketPath: value('--listen'),
  tokenFile: value('--auth-token-file'),
  pid: process.pid,
  createdAt: new Date().toISOString(),
}));
setInterval(() => {}, 1000);
`;

const FAILING_SERVER = `#!/usr/bin/env node
process.stderr.write('the agent binary is missing\\n');
process.exit(3);
`;

function writeExecutable(dir: string, name: string, source: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source, { mode: 0o755 });
  return file;
}

function workspace(): { registryDir: string; cwd: string; binDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpisp-'));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  return { registryDir: path.join(root, 'run'), cwd, binDir: root };
}

describe('createServerSpawner', () => {
  it('spawns a server and succeeds once its record appears', async () => {
    const { registryDir, cwd, binDir } = workspace();
    const command = writeExecutable(binDir, 'fake-doompi-server', REGISTERING_SERVER);
    const spawner = createServerSpawner({ registryDir, command });

    const outcome = await spawner.spawn({ cwd, name: 'fresh' });
    if (!outcome.ok) throw new Error(outcome.error);
    const record = JSON.parse(
      fs.readFileSync(path.join(registryDir, 'sessions', `${outcome.sessionId}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(record.name).toBe('fresh');
    expect(record.cwd).toBe(fs.realpathSync(cwd));
    // The prepared credentials are owner-only.
    expect(fs.statSync(record.tokenFile as string).mode & 0o077).toBe(0);
    process.kill(record.pid as number);
  }, 15_000);

  it('keeps the given session id and reuses its directory, so a restart resumes in place', async () => {
    const { registryDir, cwd, binDir } = workspace();
    const command = writeExecutable(binDir, 'fake-doompi-server', REGISTERING_SERVER);
    const spawner = createServerSpawner({ registryDir, command });

    const first = await spawner.spawn({ cwd, name: 'live' });
    if (!first.ok) throw new Error(first.error);
    const firstRecord = JSON.parse(
      fs.readFileSync(path.join(registryDir, 'sessions', `${first.sessionId}.json`), 'utf8'),
    ) as Record<string, unknown>;
    process.kill(firstRecord.pid as number);
    const sessionDir = path.dirname(firstRecord.socketPath as string);

    const second = await spawner.spawn({ cwd, name: 'live', sessionId: first.sessionId, sessionDir });
    if (!second.ok) throw new Error(second.error);
    const secondRecord = JSON.parse(
      fs.readFileSync(path.join(registryDir, 'sessions', `${first.sessionId}.json`), 'utf8'),
    ) as Record<string, unknown>;

    // Same id, so Pi resumes the session rather than starting a new one.
    expect(second.sessionId).toBe(first.sessionId);
    // Same directory, so repeated restarts cannot grow the socket path past
    // the unix limit one prefix extension at a time.
    expect(path.dirname(secondRecord.socketPath as string)).toBe(sessionDir);
    expect(secondRecord.pid).not.toBe(firstRecord.pid);
    process.kill(secondRecord.pid as number);
  }, 15_000);

  it('reports an early exit with the log tail', async () => {
    const { registryDir, cwd, binDir } = workspace();
    const command = writeExecutable(binDir, 'failing-doompi-server', FAILING_SERVER);
    const spawner = createServerSpawner({ registryDir, command });

    const outcome = await spawner.spawn({ cwd });
    expect(outcome).toMatchObject({ ok: false, code: 'spawn_failed' });
    if (outcome.ok) throw new Error('unexpected success');
    expect(outcome.error).toMatch(/exited with code 3/);
    expect(outcome.error).toMatch(/agent binary is missing/);
  }, 15_000);

  it('reports a command that does not exist', async () => {
    const { registryDir, cwd } = workspace();
    const spawner = createServerSpawner({ registryDir, command: '/definitely/not/doompi-server' });

    const outcome = await spawner.spawn({ cwd });
    expect(outcome).toMatchObject({ ok: false, code: 'spawn_failed' });
  }, 15_000);

  it('rejects a working directory that is not there', async () => {
    const { registryDir } = workspace();
    const spawner = createServerSpawner({ registryDir, command: 'irrelevant' });

    await expect(spawner.spawn({ cwd: '/no/such/dir' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    await expect(spawner.spawn({ cwd: 'relative/path' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });
});
