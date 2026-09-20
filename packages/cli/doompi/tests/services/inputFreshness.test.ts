import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  fingerprintInput,
  inputsAreFresh,
  resetInputFreshnessCache,
  type InputFingerprint,
} from '../../src/compiler/inputs';

const directories: string[] = [];

afterEach(() => {
  resetInputFreshnessCache();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function receipts(): { stale: InputFingerprint; validWithMovedStat: InputFingerprint } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-input-freshness-'));
  directories.push(directory);
  const target = path.join(directory, 'input.mjs');
  fs.writeFileSync(target, 'old');
  fs.utimesSync(target, new Date(1_000), new Date(1_000));
  const stale = fingerprintInput(target)!;

  fs.writeFileSync(target, 'new');
  fs.utimesSync(target, new Date(2_000), new Date(2_000));
  const valid = fingerprintInput(target)!;
  return { stale, validWithMovedStat: { ...valid, mtimeMs: stale.mtimeMs } };
}

describe('inputsAreFresh', () => {
  it.each([
    ['stale receipt first', false, true],
    ['valid receipt first', true, false],
  ])('keeps verdicts receipt-specific when the %s', (_name, firstExpected, secondExpected) => {
    const { stale, validWithMovedStat } = receipts();
    const first = firstExpected ? validWithMovedStat : stale;
    const second = firstExpected ? stale : validWithMovedStat;

    expect(inputsAreFresh([first])).toBe(firstExpected);
    expect(inputsAreFresh([second])).toBe(secondExpected);
  });
});
