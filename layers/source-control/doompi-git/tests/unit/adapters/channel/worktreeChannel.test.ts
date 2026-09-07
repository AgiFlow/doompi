import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktreeChannel } from '../../../../src/adapters/channel/worktreeChannel.ts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-channel-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('send and receive', () => {
  it('carries a message from parent to child', () => {
    const channel = createWorktreeChannel(root);
    channel.send('child', 'start the migration');

    const received = channel.receive('child');

    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('start the migration');
    expect(received[0]?.from).toBe('parent');
  });

  it('carries a message from child to parent', () => {
    const channel = createWorktreeChannel(root);
    channel.send('parent', 'migration done');
    expect(channel.receive('parent')[0]?.from).toBe('child');
  });

  it('does not deliver a message to the side that sent it', () => {
    const channel = createWorktreeChannel(root);
    channel.send('child', 'for the child');
    expect(channel.receive('parent')).toEqual([]);
    expect(channel.receive('child')).toHaveLength(1);
  });

  it('returns nothing for an inbox that does not exist yet', () => {
    expect(createWorktreeChannel(root).receive('parent')).toEqual([]);
  });

  // The invariant: claim by rename, so a message is delivered once even if a
  // reader polls twice.
  it('delivers each message exactly once', () => {
    const channel = createWorktreeChannel(root);
    channel.send('child', 'one');

    expect(channel.receive('child')).toHaveLength(1);
    expect(channel.receive('child')).toEqual([]);
  });

  it('keeps order and delivers every message when several are sent at once', () => {
    const channel = createWorktreeChannel(root);
    for (const text of ['one', 'two', 'three']) channel.send('child', text);

    expect(channel.receive('child').map((entry) => entry.text)).toEqual(['one', 'two', 'three']);
  });

  it('refuses a message larger than the cap rather than writing it', () => {
    const channel = createWorktreeChannel(root);
    expect(() => channel.send('child', 'x'.repeat(64 * 1024 + 1))).toThrow(/may not exceed/u);
    expect(channel.receive('child')).toEqual([]);
  });

  it('writes messages private to the account', () => {
    const channel = createWorktreeChannel(root);
    channel.send('child', 'secret');
    const [name] = fs.readdirSync(path.join(root, 'child'));
    const mode = fs.statSync(path.join(root, 'child', String(name))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves no temp file behind', () => {
    const channel = createWorktreeChannel(root);
    channel.send('child', 'one');
    expect(fs.readdirSync(path.join(root, 'child')).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });
});

describe('malformed messages', () => {
  // A message this build cannot read may come from a newer one, so destroying
  // it would turn a version skew into data loss.
  it.each([
    ['unparseable content', 'not json'],
    ['a future version', '{"version":99,"from":"parent","text":"x","sentAt":"now"}'],
    ['an unknown sender', '{"version":1,"from":"stranger","text":"x","sentAt":"now"}'],
    ['an empty text', '{"version":1,"from":"parent","text":"","sentAt":"now"}'],
  ])('does not deliver or delete %s', (_label, raw) => {
    const inbox = path.join(root, 'child');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, '00000000000001-aaaa.json'), raw);

    expect(createWorktreeChannel(root).receive('child')).toEqual([]);
    expect(fs.readdirSync(inbox)).toHaveLength(1);
  });

  it('still delivers the good messages beside a bad one', () => {
    const channel = createWorktreeChannel(root);
    const inbox = path.join(root, 'child');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, '00000000000001-aaaa.json'), 'not json');
    channel.send('child', 'good');

    expect(channel.receive('child').map((entry) => entry.text)).toEqual(['good']);
  });
});

describe('sweep', () => {
  it('returns an abandoned claim to the inbox so it is delivered again', () => {
    const channel = createWorktreeChannel(root);
    const inbox = path.join(root, 'child');
    fs.mkdirSync(inbox, { recursive: true });
    const message = JSON.stringify({ version: 1, from: 'parent', text: 'stranded', sentAt: 'now' });
    fs.writeFileSync(path.join(inbox, '.claim-9999-00000000000001-aaaa.json'), message);

    expect(channel.sweep(Date.now() + 120_000)).toBe(1);
    expect(channel.receive('child').map((entry) => entry.text)).toEqual(['stranded']);
  });

  it('leaves a fresh claim alone, because its reader may still be delivering it', () => {
    const channel = createWorktreeChannel(root);
    const inbox = path.join(root, 'child');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, '.claim-9999-00000000000001-aaaa.json'), '{}');

    expect(channel.sweep()).toBe(0);
  });

  it('does nothing when there is no channel on disk', () => {
    expect(createWorktreeChannel(path.join(root, 'absent')).sweep()).toBe(0);
  });
});
