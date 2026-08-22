import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeFileTag,
  decodeUtf8,
  displayPath,
  isWritableFile,
  resolveInputPath,
  resolveReadInputPath,
} from '../src/adapters/node/files.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('hashline file helpers', () => {
  it('computes stable exact-byte SHA-256 tags', () => {
    expect(computeFileTag(Buffer.from('hello', 'utf8'))).toBe('LPJNul-w');
    expect(computeFileTag(Buffer.from('hello\n', 'utf8'))).not.toBe(computeFileTag(Buffer.from('hello', 'utf8')));
  });

  it('decodes valid UTF-8 strictly and preserves the original cause on failure', () => {
    expect(decodeUtf8(Buffer.from('héllo', 'utf8'), 'valid.txt')).toBe('héllo');

    let failure: unknown;
    try {
      decodeUtf8(Uint8Array.from([0x80]), 'binary.txt');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: expect.stringContaining('binary.txt'), cause: expect.any(Error) });
  });

  it('reports whether an existing path is writable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'doompi-hashline-writable-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'writable.txt');
    await writeFile(path, 'content');

    await expect(isWritableFile(path)).resolves.toBe(true);
    await expect(isWritableFile(join(directory, 'missing.txt'))).resolves.toBe(false);
  });

  it('resolves relative, absolute, and home-relative inputs', () => {
    expect(resolveInputPath('src/a.ts', '/repo')).toBe(resolve('/repo', 'src/a.ts'));
    expect(resolveInputPath('/tmp/a.ts', '/repo')).toBe(resolve('/tmp/a.ts'));
    expect(resolveInputPath('~', '/repo')).toBe(homedir());
    expect(resolveInputPath('~/a.ts', '/repo')).toBe(resolve(homedir(), 'a.ts'));
  });

  it('matches Pi normalization for at prefixes, Unicode spaces, and file URLs', () => {
    expect(resolveInputPath('@src/a.ts', '/repo')).toBe(resolve('/repo', 'src/a.ts'));
    expect(resolveInputPath('space\u00a0name/a.ts', '/repo')).toBe(resolve('/repo', 'space name/a.ts'));
    expect(resolveInputPath(pathToFileURL('/tmp/a.ts').href, '/repo')).toBe(resolve('/tmp/a.ts'));
  });

  it('matches Pi read fallbacks for curly quotes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'doompi-hashline-files-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'capture’s.txt');
    await writeFile(path, 'content');

    await expect(resolveReadInputPath("capture's.txt", directory)).resolves.toBe(path);
  });

  it('uses portable relative paths inside cwd and absolute paths outside it', () => {
    expect(displayPath(resolve('/repo', 'src/a.ts'), '/repo')).toBe('src/a.ts');
    expect(displayPath('/tmp/a.ts', '/repo')).toBe('/tmp/a.ts');
    expect(displayPath(resolve('/repo', '~', 'a.ts'), '/repo')).toBe('./~/a.ts');
  });
});
