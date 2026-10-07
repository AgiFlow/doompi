import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sessionAttachmentRoot, writeSessionAttachment } from '../../../../src/services/sessionAttachments';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function agentEnvironment(): { PI_CODING_AGENT_DIR: string } {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-attachments-'));
  directories.push(agentDir);
  return { PI_CODING_AGENT_DIR: agentDir };
}

describe('session attachments', () => {
  it('stores each attachment privately under its own directory', async () => {
    const environment = agentEnvironment();
    const stored = await writeSessionAttachment('session-1', 'report.pdf', Buffer.from('%PDF'), environment);

    const root = path.join(environment.PI_CODING_AGENT_DIR, 'doom-attachments', 'session-1');
    expect(sessionAttachmentRoot('session-1', environment)).toBe(root);
    expect(path.dirname(path.dirname(stored.path))).toBe(root);
    expect(path.basename(stored.path)).toBe('report.pdf');
    expect(stored).toMatchObject({ name: 'report.pdf', size: 4, mimeType: 'application/pdf' });
    expect(fs.readFileSync(stored.path, 'utf8')).toBe('%PDF');
    expect(fs.statSync(stored.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(stored.path)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(stored.path))).toEqual(['report.pdf']);
  });

  it('sanitises names so they stay one plain file name', async () => {
    const environment = agentEnvironment();
    const name = async (raw: string) =>
      (await writeSessionAttachment('session-1', raw, Buffer.from('x'), environment)).name;

    expect(await name('../a/b\\c\u0001\u007f.txt')).toBe('abc.txt');
    expect(await name('..')).toBe('file');
    expect(await name('.')).toBe('file');
    expect(await name('')).toBe('file');
    expect(await name('/\\\u0000')).toBe('file');
    expect(await name('.env')).toBe('env');
    expect(await name('unknown.bin')).toBe('unknown.bin');
    expect((await writeSessionAttachment('session-1', 'x.unknown', Buffer.from('x'), environment)).mimeType).toBe(
      'application/octet-stream',
    );
    const long = await name(`${'é'.repeat(300)}.pdf`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith('é')).toBe(true);
  });

  it('refuses session ids that would name a parent directory', async () => {
    const environment = agentEnvironment();
    for (const sessionId of ['', '.', '..']) {
      expect(() => sessionAttachmentRoot(sessionId, environment)).toThrow();
      await expect(writeSessionAttachment(sessionId, 'a.txt', Buffer.from('x'), environment)).rejects.toThrow();
    }
    expect(sessionAttachmentRoot('../escape', environment)).toBe(
      path.join(environment.PI_CODING_AGENT_DIR, 'doom-attachments', '.._escape'),
    );
    expect(fs.readdirSync(environment.PI_CODING_AGENT_DIR)).toEqual([]);
  });

  it('sweeps attachment directories older than seven days on every write', async () => {
    const environment = agentEnvironment();
    const old = await writeSessionAttachment('other-session', 'old.txt', Buffer.from('old'), environment);
    const fresh = await writeSessionAttachment('other-session', 'fresh.txt', Buffer.from('fresh'), environment);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.dirname(old.path), eightDaysAgo, eightDaysAgo);

    await writeSessionAttachment('session-1', 'new.txt', Buffer.from('new'), environment);

    expect(fs.existsSync(path.dirname(old.path))).toBe(false);
    expect(fs.readFileSync(fresh.path, 'utf8')).toBe('fresh');
  });
});
