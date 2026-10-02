import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

const { signCatalogArchives } = createRequire(import.meta.url)('../../scripts/signHubBinaries.cjs') as {
  signCatalogArchives: (directory: string, sign: (binary: string) => void) => number;
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function catalogFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sign-test-'));
  roots.push(root);
  const catalog = path.join(root, 'catalog');
  const source = path.join(root, 'source');
  const packageRoot = path.join(source, 'package');
  fs.mkdirSync(catalog);
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"native-fixture","version":"1.0.0"}');
  const textArchive = path.join(catalog, 'text.tgz');
  execFileSync('tar', ['-czf', textArchive, '-C', source, 'package']);
  const executable = path.join(packageRoot, 'bin', 'helper');
  fs.writeFileSync(executable, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o755 });
  fs.symlinkSync('bin/helper', path.join(packageRoot, 'helper-link'));
  const archive = path.join(catalog, 'native.tgz');
  execFileSync('tar', ['-czf', archive, '-C', source, 'package']);
  fs.writeFileSync(path.join(catalog, 'index.json'), '{"packages":{"native-fixture":{"archive":"native.tgz"}}}');
  return { root, source, catalog, executable, archive, textArchive };
}

it('signs archived Mach-O payloads without changing source files, metadata or text-only archives', () => {
  const fixture = catalogFixture();
  const original = fs.readFileSync(fixture.executable);
  const text = fs.readFileSync(fixture.textArchive);
  const index = fs.readFileSync(path.join(fixture.catalog, 'index.json'));
  expect(
    signCatalogArchives(fixture.catalog, (binary) => {
      expect(binary.startsWith(`${fixture.catalog}${path.sep}.sign-`)).toBe(true);
      fs.appendFileSync(binary, 'signed');
    }),
  ).toBe(1);
  const extracted = path.join(fixture.root, 'extracted');
  fs.mkdirSync(extracted);
  execFileSync('tar', ['-xzf', fixture.archive, '-C', extracted]);
  const binary = path.join(extracted, 'package', 'bin', 'helper');
  expect(fs.readFileSync(binary)).toEqual(Buffer.concat([original, Buffer.from('signed')]));
  expect(fs.statSync(binary).mode & 0o777).toBe(0o755);
  expect(fs.readlinkSync(path.join(extracted, 'package', 'helper-link'))).toBe('bin/helper');
  expect(fs.readFileSync(path.join(extracted, 'package', 'package.json'))).toEqual(
    fs.readFileSync(path.join(fixture.source, 'package', 'package.json')),
  );
  expect(fs.readFileSync(fixture.executable)).toEqual(original);
  expect(fs.readFileSync(fixture.textArchive)).toEqual(text);
  expect(fs.readFileSync(path.join(fixture.catalog, 'index.json'))).toEqual(index);
  expect(fs.readdirSync(fixture.catalog).sort()).toEqual(['index.json', 'native.tgz', 'text.tgz']);
});

it('preserves the archive and removes temporary extraction when signing fails', () => {
  const fixture = catalogFixture();
  const original = fs.readFileSync(fixture.archive);
  expect(() =>
    signCatalogArchives(fixture.catalog, (binary) => {
      fs.appendFileSync(binary, 'partial-signature');
      throw new Error('signing failed');
    }),
  ).toThrow('signing failed');
  expect(fs.readFileSync(fixture.archive)).toEqual(original);
  expect(fs.readdirSync(fixture.catalog).sort()).toEqual(['index.json', 'native.tgz', 'text.tgz']);
});
