import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerSettingsLoader } from '../../src/adapters/RunnerSettings/RunnerSettingsLoader';
import { parseResultPragma } from '../../src/exports/tool/responseEnvelope';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-settings-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeSettings(contents: string): void {
  const configDirectory = path.join(directory, CONFIG_DIR_NAME);
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, 'doompi-runner.json'), contents);
}

describe('RunnerSettingsLoader', () => {
  const loader = new RunnerSettingsLoader();

  it('reads the documented per-extension config path', () => {
    writeSettings(JSON.stringify({ maxResultBytes: 32_768, maxResultLines: 300 }));
    expect(loader.load(directory, true)).toEqual({
      settings: { maxResultBytes: 32_768, maxResultLines: 300 },
      issues: [],
    });
  });

  it('ignores project config entirely when the project is untrusted', () => {
    writeSettings(JSON.stringify({ maxResultBytes: 32_768 }));
    expect(loader.load(directory, false)).toEqual({ settings: {}, issues: [] });
  });

  it('returns empty settings when no file exists', () => {
    expect(loader.load(directory, true)).toEqual({ settings: {}, issues: [] });
  });

  it('reports a typo rather than silently ignoring it', () => {
    writeSettings(JSON.stringify({ maxResultByte: 32_768 }));
    const result = loader.load(directory, true);
    expect(result.settings).toEqual({});
    expect(result.issues).toContain('unknown key maxResultByte');
  });

  it('rejects values that would flood the model context', () => {
    writeSettings(JSON.stringify({ maxResultBytes: 99_999_999, headRatio: 4 }));
    const result = loader.load(directory, true);
    expect(result.settings.maxResultBytes).toBe(262_144);
    expect(result.settings.headRatio).toBeUndefined();
    expect(result.issues).toContain('headRatio must be a number above 0 and below 1');
  });

  it('keeps valid custom patterns and reports the broken one', () => {
    writeSettings(JSON.stringify({ errorPatterns: ['^FEHLER', '([unclosed'] }));
    const result = loader.load(directory, true);
    expect(result.settings.errorPatterns).toEqual(['^FEHLER']);
    expect(result.issues.some((issue) => issue.includes('not a valid regular expression'))).toBe(true);
  });

  it('reports malformed JSON instead of throwing', () => {
    writeSettings('{ not json');
    expect(loader.load(directory, true).issues).toEqual(['doompi-runner.json is not valid JSON']);
  });
});

describe('parseResultPragma', () => {
  it('reads a first-line budget override', () => {
    expect(parseResultPragma('# @doom: {"maxResultBytes": 32768, "maxResultLines": 300}\nnpm test')).toEqual({
      maxBytes: 32_768,
      maxLines: 300,
    });
  });

  it('accepts the slash comment form', () => {
    expect(parseResultPragma('// @doom: {"maxResultLines": 40}\nnpm test')).toEqual({ maxLines: 40 });
  });

  it('ignores a pragma that is not on the first line', () => {
    expect(parseResultPragma('npm test\n# @doom: {"maxResultBytes": 32768}')).toEqual({});
  });

  it('ignores malformed or hostile values', () => {
    expect(parseResultPragma('# @doom: {oops}\nnpm test')).toEqual({});
    expect(parseResultPragma('# @doom: {"maxResultBytes": -1}\nnpm test')).toEqual({});
    expect(parseResultPragma('# @doom: [1,2]\nnpm test')).toEqual({});
  });

  it('caps a pragma that asks for more than the context can take', () => {
    expect(parseResultPragma('# @doom: {"maxResultBytes": 99999999}\nnpm test')).toEqual({ maxBytes: 262_144 });
  });

  it('leaves an ordinary command alone', () => {
    expect(parseResultPragma('npm test')).toEqual({});
  });
});
