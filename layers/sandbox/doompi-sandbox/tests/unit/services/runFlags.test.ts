import { describe, expect, it } from 'vitest';
import { assertRunFlags, parseRunFlags } from '../../../src/services/runFlags.ts';

const OPTION_NAME = 'DOOMPI_SANDBOX_RUN_FLAGS';

describe('parseRunFlags', () => {
  it('splits configured options on whitespace', () => {
    expect(parseRunFlags('--runtime=runsc')).toEqual(['--runtime=runsc']);
    expect(parseRunFlags('--runtime=kata --memory=2g')).toEqual(['--runtime=kata', '--memory=2g']);
  });

  it('answers empty for absent or blank configuration', () => {
    expect(parseRunFlags(undefined)).toEqual([]);
    expect(parseRunFlags('   ')).toEqual([]);
  });

  it('ignores padding around configured options', () => {
    expect(parseRunFlags('  --runtime=runsc   --read-only ')).toEqual(['--runtime=runsc', '--read-only']);
  });
});

describe('assertRunFlags', () => {
  it('accepts long and short options, with or without a value', () => {
    expect(() => assertRunFlags(['--runtime=runsc', '--read-only', '-q'], OPTION_NAME)).not.toThrow();
  });

  it('refuses a positional value that would replace the image', () => {
    expect(() => assertRunFlags(['alpine'], OPTION_NAME)).toThrowError(/"alpine" is neither/);
  });

  it('refuses a separated value and points at the joined form', () => {
    expect(() => assertRunFlags(['--runtime', 'runsc'], OPTION_NAME)).toThrowError(/for example --runtime=runsc/);
  });

  it('names the option that carried the bad value', () => {
    expect(() => assertRunFlags(['bash'], OPTION_NAME)).toThrowError(/DOOMPI_SANDBOX_RUN_FLAGS accepts engine options/);
  });
});
