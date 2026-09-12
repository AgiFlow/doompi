import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMajorModesConfig, loadMajorModesConfigLenient } from '../src/exports/majorModes';

describe('loadMajorModesConfigLenient', () => {
  let root: string;
  /** Isolated home, so a developer's own ~/.pi/.doom never reaches these tests. */
  let home: string;

  function writeRepoModes(contents: string): void {
    fs.writeFileSync(path.join(root, '.doom', 'modes.yaml'), contents);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-modes-lenient-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-modes-lenient-home-'));
    fs.mkdirSync(path.join(root, '.doom'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const UNKNOWN_FIELD_MODES =
    'layers: {}\nmajorMode:\n  copilot:\n    description: Copilot mode.\n    layers: []\n    typo: true\n';

  it('still throws on an unknown field through the strict loader', () => {
    writeRepoModes(UNKNOWN_FIELD_MODES);

    expect(() => loadMajorModesConfig(root, home)).toThrow(/unsupported field\(s\): typo/);
  });

  it('collects the unknown field and still resolves the major mode', () => {
    writeRepoModes(UNKNOWN_FIELD_MODES);

    const { config, diagnostics } = loadMajorModesConfigLenient(root, home);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.path).toBe('typo');
    expect(diagnostics[0]?.filePath).toBe(path.join('.doom', 'modes.yaml'));
    expect(config.majorMode.copilot?.description).toBe('Copilot mode.');
  });

  it('reports nothing for a clean file', () => {
    writeRepoModes('layers: {}\nmajorMode:\n  copilot: []\n');

    expect(loadMajorModesConfigLenient(root, home).diagnostics).toEqual([]);
  });

  // Unknown keys only. A malformed value is still a real fault.
  it('still throws on an invalid value for a known key', () => {
    writeRepoModes('layers: {}\nmajorMode:\n  copilot:\n    description: " "\n    layers: []\n');

    expect(() => loadMajorModesConfigLenient(root, home)).toThrow(/description must be a non-empty string/);
  });

  it('leaves the strict loader unaffected afterwards', () => {
    writeRepoModes(UNKNOWN_FIELD_MODES);
    loadMajorModesConfigLenient(root, home);

    expect(() => loadMajorModesConfig(root, home)).toThrow(/unsupported field\(s\): typo/);
  });
});
