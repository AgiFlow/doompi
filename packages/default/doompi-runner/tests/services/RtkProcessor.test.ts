import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyRtkFilter,
  RTK_STDIN_MAX_BYTES,
  RtkProcessor,
  rtkPackageForTarget,
} from '../../src/adapters/RtkProcessor/RtkProcessor';
import { RESULT_MAX_BYTES_ENV } from '../../src/types/config';

let directory: string;
let previousResultMaxBytes: string | undefined;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-rtk-'));
  previousResultMaxBytes = process.env[RESULT_MAX_BYTES_ENV];
});

afterEach(() => {
  if (previousResultMaxBytes === undefined) delete process.env[RESULT_MAX_BYTES_ENV];
  else process.env[RESULT_MAX_BYTES_ENV] = previousResultMaxBytes;
  fs.rmSync(directory, { recursive: true, force: true });
});

function executable(source: string): string {
  const target = path.join(directory, `rtk-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(target, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return target;
}

function log(contents: string): string {
  const target = path.join(directory, 'command.log');
  fs.writeFileSync(target, contents);
  return target;
}

describe('classifyRtkFilter', () => {
  it.each([
    ['cargo test', 'cargo-test'],
    ['cargo test --workspace', 'cargo-test'],
    ['pytest tests/unit', 'pytest'],
    ['git diff --cached', 'git-diff'],
    ['grep -nH needle src/file.ts', 'grep'],
    ['rg -nH --no-heading needle src', 'grep'],
    ['go test -json ./...', 'go-test'],
    ['ruff check . --output-format=json', 'ruff-check'],
  ] as const)('maps %s to %s', (command, filter) => {
    expect(classifyRtkFilter(command)).toBe(filter);
  });

  it.each([
    'cargo test && echo done',
    'pytest | tee result.txt',
    'git diff > patch.txt',
    'pytest $(cat target)',
    'pytest `cat target`',
    'env CI=1 pytest',
    'sudo cargo test',
    'cargo test -- --format=json',
    'git diff --stat',
    'git diff --color=always',
    'git diff --color-words',
    'git diff --patch-with-raw',
    'git diff --ext-diff',
    'git diff --textconv',
    'git log',
    'git status',
    'grep needle src/file.ts',
    'grep -nHC2 needle src/file.ts',
    'grep -nHh needle src/file.ts',
    'grep -nHz needle src/file.ts',
    'grep -nH --colour=always needle src/file.ts',
    'rg -nH --json needle src',
    'rg -nH --no-heading --context=2 needle src',
    'rg -nH --no-heading --no-line-number needle src',
    'go test ./...',
    'go test -json -json=false ./...',
    'ruff check .',
    'npm test',
    'docker ps',
    'pytest "tests/unit"',
  ])('keeps %s on raw output', (command) => {
    expect(classifyRtkFilter(command)).toBeUndefined();
  });
});

describe('rtkPackageForTarget', () => {
  it.each([
    ['darwin', 'arm64', '@agimon-ai/doompi-runner-rtk-darwin-arm64'],
    ['darwin', 'x64', '@agimon-ai/doompi-runner-rtk-darwin-x64'],
    ['linux', 'arm64', '@agimon-ai/doompi-runner-rtk-linux-arm64'],
    ['linux', 'x64', '@agimon-ai/doompi-runner-rtk-linux-x64'],
  ] as const)('maps %s-%s to %s', (platform, architecture, packageName) => {
    expect(rtkPackageForTarget(platform, architecture)).toBe(packageName);
  });
});

describe('RtkProcessor', () => {
  it('streams the complete raw log through the selected pipe filter', async () => {
    const binary = executable(`
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(process.argv.slice(2).join(' ') + '\\nfiltered:' + Buffer.concat(chunks).toString('utf8'));
`);
    const processor = new RtkProcessor(() => binary);

    await expect(processor.process({ command: 'pytest', logPath: log('alpha\nbeta\n') })).resolves.toEqual({
      kind: 'processed',
      result: { filter: 'pytest', head: '', output: 'pipe -f pytest\nfiltered:alpha\nbeta\n', bytes: 35, lines: 3 },
    });
  });

  it('does not resolve or spawn RTK for an unsupported command', async () => {
    const resolveBinary = vi.fn(() => executable('process.exit(99);'));
    const processor = new RtkProcessor(resolveBinary);

    await expect(processor.process({ command: 'git status', logPath: log('clean\n') })).resolves.toEqual({
      kind: 'skipped',
    });
    expect(resolveBinary).not.toHaveBeenCalled();
  });

  it('returns raw fallback warnings for missing and failed RTK', async () => {
    const logPath = log('failure details\n');
    const missing = new RtkProcessor(() => undefined);
    const failed = new RtkProcessor(() => executable('process.stdin.resume(); process.exitCode = 2;'));

    await expect(missing.process({ command: 'cargo test', logPath })).resolves.toMatchObject({
      kind: 'fallback',
      warning: expect.stringContaining('unavailable'),
    });
    await expect(failed.process({ command: 'cargo test', logPath })).resolves.toMatchObject({
      kind: 'fallback',
      warning: expect.stringContaining('failed'),
    });
  });

  it('falls back when RTK drops a non-empty raw log', async () => {
    const empty = new RtkProcessor(() => executable('process.stdin.resume();'));

    await expect(
      empty.process({ command: 'cargo test', logPath: log('important raw output\n') }),
    ).resolves.toMatchObject({
      kind: 'fallback',
      warning: expect.stringContaining('failed'),
    });
  });

  it('does not chmod an executable installed on a read-only filesystem', async () => {
    const binary = executable(`
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('filtered'));
`);
    fs.chmodSync(binary, 0o555);
    const chmod = vi.spyOn(fs, 'chmodSync');

    try {
      await expect(
        new RtkProcessor(() => binary).process({ command: 'pytest', logPath: log('raw\n') }),
      ).resolves.toMatchObject({
        kind: 'processed',
      });
      expect(chmod).not.toHaveBeenCalled();
    } finally {
      chmod.mockRestore();
    }
  });

  it('restores execute permission on a packed RTK payload', async () => {
    const binary = executable(`
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('filtered'));
`);
    fs.chmodSync(binary, 0o644);
    const chmod = vi.spyOn(fs, 'chmodSync');

    try {
      await expect(
        new RtkProcessor(() => binary).process({ command: 'pytest', logPath: log('raw\n') }),
      ).resolves.toMatchObject({ kind: 'processed' });
      expect(chmod).toHaveBeenCalledWith(binary, 0o755);
    } finally {
      chmod.mockRestore();
    }
  });
  it('does not start RTK above its 10 MiB stdin cap', async () => {
    const logPath = path.join(directory, 'oversized.log');
    fs.closeSync(fs.openSync(logPath, 'w'));
    fs.truncateSync(logPath, RTK_STDIN_MAX_BYTES + 1);
    const resolveBinary = vi.fn(() => executable('process.exit(99);'));
    const processor = new RtkProcessor(resolveBinary);

    await expect(processor.process({ command: 'pytest', logPath })).resolves.toMatchObject({
      kind: 'fallback',
      warning: expect.stringContaining('10 MiB'),
    });
    expect(resolveBinary).not.toHaveBeenCalled();
  });

  it('times out RTK without changing the command result contract', async () => {
    const binary = executable('process.stdin.resume(); setInterval(() => undefined, 1000);');
    const processor = new RtkProcessor(() => binary, 30);

    await expect(processor.process({ command: 'pytest', logPath: log('raw\n') })).resolves.toMatchObject({
      kind: 'fallback',
      warning: expect.stringContaining('timed out'),
    });
  });

  it('tail-caps RTK stdout while retaining its exact output metadata', async () => {
    process.env[RESULT_MAX_BYTES_ENV] = '16';
    const binary = executable(`
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('x'.repeat(1000)));
`);
    const processor = new RtkProcessor(() => binary);
    const result = await processor.process({ command: 'pytest', logPath: log('raw\n') });

    expect(result).toMatchObject({ kind: 'processed', result: { bytes: 1000, lines: 1 } });
    if (result.kind !== 'processed') throw new Error('Expected processed RTK output');
    expect(Buffer.byteLength(result.result.output)).toBeLessThanOrEqual(32);
  });
});
