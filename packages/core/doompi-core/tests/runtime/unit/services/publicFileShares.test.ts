import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DOOM_SHARE_FILE_REMOTE_OFF_MESSAGE } from '../../../../src/exports/packageApi';
import { createPublicFileShares } from '../../../../src/services/publicFileShares';
import { writeSessionAttachment } from '../../../../src/services/sessionAttachments';

const ORIGIN = 'https://remote.example.com';
const TOKEN_URL = /^https:\/\/remote\.example\.com\/mcp-file\/([A-Za-z0-9_-]{43})$/u;
const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-shares-'));
  directories.push(root);
  const cwd = path.join(root, 'repo');
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(cwd, 'docs', 'report.pdf'), '%PDF-1.7 report');
  fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(cwd, '.git', 'config'), '[core]');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(root, 'outside.txt'), path.join(cwd, 'escape.txt'));
  fs.symlinkSync(path.join(cwd, '.env'), path.join(cwd, 'env-link.txt'));
  fs.writeFileSync(path.join(cwd, 'large.bin'), '');
  fs.truncateSync(path.join(cwd, 'large.bin'), 25 * 1024 * 1024 + 1);
  let origin: string | undefined = ORIGIN;
  let revision = 1;
  const onNotice = vi.fn();
  const environment = { PI_CODING_AGENT_DIR: agentDir };
  const shares = createPublicFileShares({
    publicOrigin: () => origin,
    publicOriginRevision: () => revision,
    onNotice,
    environment,
  });
  const mint = (filePath: string, sessionId = 'session-1') =>
    shares.mint({ sessionId, cwd, path: filePath, label: 'agiflow / attach_task_artifact' });
  return {
    root,
    cwd,
    environment,
    shares,
    mint,
    onNotice,
    setOrigin(value: string | undefined) {
      origin = value;
    },
    bumpRevision() {
      revision += 1;
    },
  };
}

function tokenOf(url: string): string {
  const match = TOKEN_URL.exec(url);
  if (match === null) throw new Error(`Unexpected share URL: ${url}`);
  return match[1];
}

async function expectNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Not found.' });
}

describe('public file shares', () => {
  it('refuses to mint while remote access is off', async () => {
    const files = fixture();
    files.setOrigin(undefined);
    await expect(files.mint('docs/report.pdf')).rejects.toThrow(DOOM_SHARE_FILE_REMOTE_OFF_MESSAGE);
    expect(DOOM_SHARE_FILE_REMOTE_OFF_MESSAGE).toBe(
      'Remote access is off, so DoomPi cannot share files with remote MCP servers. Turn it on and retry.',
    );
  });

  it('refuses paths outside the working directory, dot paths, and non-regular files', async () => {
    const files = fixture();
    for (const refused of [
      '../outside.txt',
      path.join(files.root, 'outside.txt'),
      'escape.txt',
      '.env',
      'env-link.txt',
      '.git/config',
      './docs/report.pdf',
      'docs/../docs/report.pdf',
      'docs',
      '.',
      '',
      'docs/report.pdf\0',
      'missing.pdf',
      'large.bin',
    ])
      await expect(files.mint(refused), refused).rejects.toThrow();
    const shared = await files.mint('docs/report.pdf');
    expect(shared).toMatchObject({ fileName: 'report.pdf', mimeType: 'application/pdf', size: 15 });
    expect(shared.url).toMatch(TOKEN_URL);
    expect((await files.mint(path.join(files.cwd, 'docs', 'report.pdf'))).fileName).toBe('report.pdf');
  });

  it('shares a file from the session attachment root but not another session', async () => {
    const files = fixture();
    const attached = await writeSessionAttachment('session-1', 'scan.png', Buffer.from('png'), files.environment);
    const shared = await files.mint(attached.path);
    expect(shared).toMatchObject({ fileName: 'scan.png', mimeType: 'image/png', size: 3 });
    await expect(files.mint(attached.path, 'session-2')).rejects.toThrow();
  });

  it('serves three GETs with free HEADs, then forgets the link', async () => {
    const files = fixture();
    const token = tokenOf((await files.mint('docs/report.pdf')).url);
    const head = await files.shares.serve(token, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get('content-length')).toBe('15');
    for (let use = 0; use < 3; use += 1) {
      const response = await files.shares.serve(token, 'GET');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('%PDF-1.7 report');
    }
    await expectNotFound(await files.shares.serve(token, 'GET'));
    await expectNotFound(await files.shares.serve(token, 'HEAD'));
  });

  it('answers with inert download headers only', async () => {
    const files = fixture();
    fs.writeFileSync(path.join(files.cwd, "naïve 'report'.pdf"), 'pdf');
    const token = tokenOf((await files.mint("naïve 'report'.pdf")).url);
    const response = await files.shares.serve(token, 'GET');
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      'accept-ranges': 'none',
      'cache-control': 'no-store, private',
      'content-disposition': "attachment; filename*=UTF-8''na%C3%AFve%20%27report%27.pdf",
      'content-length': '3',
      'content-security-policy': "sandbox; default-src 'none'",
      'content-type': 'application/octet-stream',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex',
    });
    await response.arrayBuffer();
  });

  it('expires links after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const files = fixture();
    const token = tokenOf((await files.mint('docs/report.pdf')).url);
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 - 1);
    expect((await files.shares.serve(token, 'HEAD')).status).toBe(200);
    vi.setSystemTime(Date.now() + 1);
    await expectNotFound(await files.shares.serve(token, 'GET'));
  });

  it('forgets links when the tunnel revision changes or remote access turns off', async () => {
    const files = fixture();
    const first = tokenOf((await files.mint('docs/report.pdf')).url);
    files.bumpRevision();
    await expectNotFound(await files.shares.serve(first, 'GET'));
    const second = tokenOf((await files.mint('docs/report.pdf')).url);
    files.setOrigin(undefined);
    await expectNotFound(await files.shares.serve(second, 'GET'));
    files.setOrigin(ORIGIN);
    await expectNotFound(await files.shares.serve(second, 'GET'));
  });

  it('refuses a file whose identity changed after the link was minted', async () => {
    const files = fixture();
    const target = path.join(files.cwd, 'docs', 'report.pdf');
    const swapped = tokenOf((await files.mint('docs/report.pdf')).url);
    fs.writeFileSync(path.join(files.cwd, 'docs', 'other.pdf'), '%PDF-1.7 others');
    fs.renameSync(path.join(files.cwd, 'docs', 'other.pdf'), target);
    await expectNotFound(await files.shares.serve(swapped, 'GET'));

    const linked = tokenOf((await files.mint('docs/report.pdf')).url);
    fs.rmSync(target);
    fs.symlinkSync(path.join(files.root, 'outside.txt'), target);
    await expectNotFound(await files.shares.serve(linked, 'GET'));

    fs.rmSync(target);
    fs.writeFileSync(target, '%PDF-1.7 report');
    const grown = tokenOf((await files.mint('docs/report.pdf')).url);
    fs.appendFileSync(target, ' and more');
    await expectNotFound(await files.shares.serve(grown, 'GET'));
  });

  it('refuses a link whose parent directory was swapped for a symlink', async () => {
    const files = fixture();
    const token = tokenOf((await files.mint('docs/report.pdf')).url);
    fs.renameSync(path.join(files.cwd, 'docs'), path.join(files.root, 'moved-docs'));
    fs.symlinkSync(path.join(files.root, 'moved-docs'), path.join(files.cwd, 'docs'));
    await expectNotFound(await files.shares.serve(token, 'GET'));
  });

  it('revokes a link and caps live links per session', async () => {
    const files = fixture();
    const first = await files.mint('docs/report.pdf');
    first.revoke();
    first.revoke();
    await expectNotFound(await files.shares.serve(tokenOf(first.url), 'GET'));
    const live = await Promise.all(Array.from({ length: 16 }, () => files.mint('docs/report.pdf')));
    await expect(files.mint('docs/report.pdf')).rejects.toThrow(/16/u);
    expect((await files.mint('docs/report.pdf', 'session-2')).url).toMatch(TOKEN_URL);
    live[0].revoke();
    expect((await files.mint('docs/report.pdf')).url).toMatch(TOKEN_URL);
  });

  it('answers malformed and unknown tokens with the same 404', async () => {
    const files = fixture();
    await files.mint('docs/report.pdf');
    await expectNotFound(await files.shares.serve('A'.repeat(43), 'GET'));
    await expectNotFound(await files.shares.serve('../../etc/passwd', 'GET'));
    await expectNotFound(await files.shares.serve('', 'HEAD'));
  });

  it('never tells onNotice the token or the URL', async () => {
    const files = fixture();
    const shared = await files.mint('docs/report.pdf');
    const token = tokenOf(shared.url);
    await (await files.shares.serve(token, 'GET')).arrayBuffer();
    shared.revoke();
    files.setOrigin(undefined);
    await files.mint('docs/report.pdf').catch(() => undefined);
    expect(files.onNotice).toHaveBeenCalled();
    for (const [message] of files.onNotice.mock.calls as [string][]) {
      expect(message).not.toContain(token);
      expect(message).not.toContain('/mcp-file/');
    }
  });
});
