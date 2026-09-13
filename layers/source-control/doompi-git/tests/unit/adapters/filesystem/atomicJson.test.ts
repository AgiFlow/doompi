import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readJson, writeJsonAtomic } from '../../../../src/services/atomicJson';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-atomic-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('round-trips through readJson and creates missing directories', () => {
    const file = path.join(directory, 'nested', 'deeper', 'state.json');
    writeJsonAtomic(file, { entries: [1, 2], name: 'x' });
    expect(readJson<{ entries: number[]; name: string }>(file)).toEqual({ entries: [1, 2], name: 'x' });
  });

  it('replaces an existing file and leaves no temporary behind', () => {
    // The replace is the whole point: a reader must see the old file or the
    // new one, never the scratch file used to make the swap.
    const file = path.join(directory, 'state.json');
    fs.writeFileSync(file, 'this was here first');
    writeJsonAtomic(file, { generation: 2 });

    expect(readJson<{ generation: number }>(file)).toEqual({ generation: 2 });
    expect(fs.readdirSync(directory)).toEqual(['state.json']);
  });

  it('writes owner-only, because the registry names local processes', () => {
    const file = path.join(directory, 'state.json');
    writeJsonAtomic(file, { secret: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('readJson', () => {
  it('treats a missing file as absent rather than throwing', () => {
    expect(() => readJson(path.join(directory, 'nope.json'))).not.toThrow();
    expect(readJson(path.join(directory, 'nope.json'))).toBeUndefined();
  });

  it('treats unparseable content as absent rather than throwing', () => {
    const file = path.join(directory, 'torn.json');
    fs.writeFileSync(file, '{"entries": [');
    expect(() => readJson(file)).not.toThrow();
    expect(readJson(file)).toBeUndefined();
  });

  it('treats a directory in place of the file as absent', () => {
    const file = path.join(directory, 'a-directory.json');
    fs.mkdirSync(file);
    expect(readJson(file)).toBeUndefined();
  });
});
