import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDoomConfig } from '../src/exports/config.ts';
import { setDoomConfigValue, unsetDoomConfigValue, writeDoomConfigValues } from '../src/exports/configWriter.ts';

let directory: string;
let filePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-config-writer-'));
  filePath = path.join(directory, 'config.yaml');
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

const read = (): string => fs.readFileSync(filePath, 'utf8');
const siblings = (): string[] => fs.readdirSync(directory).filter((entry) => entry !== 'config.yaml');

describe('writeDoomConfigValues', () => {
  it('preserves comments and unrelated keys', async () => {
    fs.writeFileSync(filePath, '# keep this comment\nmodes:\n  planning:\n    main:\n      thinking: high\n');
    await setDoomConfigValue(filePath, ['editor', 'command'], 'nvim +{line} {file}');
    const output = read();
    expect(output).toContain('# keep this comment');
    expect(output).toContain('thinking: high');
    expect(parseDoomConfig(output, filePath).editor?.command).toBe('nvim +{line} {file}');
  });

  it('seeds an absent file as a block map rather than a flow map', async () => {
    await setDoomConfigValue(filePath, ['editor', 'command'], 'vi {file}');
    // The flow form `{ editor: { command: vi {file} } }` also parses, so asserting
    // a round trip alone would not catch it. yaml keeps whichever style it started
    // with, so a flow seed makes every later write grow one unreadable line.
    expect(read()).toBe('editor:\n  command: vi {file}\n');
  });

  it('applies a set and an unset as one write, for the exclusive model keys', async () => {
    fs.writeFileSync(filePath, 'voice:\n  adapters:\n    mlx-whisper:\n      model:\n        path: /models/a.bin\n');
    await writeDoomConfigValues(filePath, [
      { keyPath: ['voice', 'adapters', 'mlx-whisper', 'model', 'id'], value: 'mlx-community/whisper-small-mlx' },
      { keyPath: ['voice', 'adapters', 'mlx-whisper', 'model', 'path'] },
    ]);
    const model = parseDoomConfig(read(), filePath).voice?.adapters?.['mlx-whisper']?.model;
    expect(model).toEqual({ id: 'mlx-community/whisper-small-mlx' });
  });

  it('rejects a value the schema refuses and leaves the file byte-identical', async () => {
    const original = 'voice:\n  engine: auto\n';
    fs.writeFileSync(filePath, original);
    await expect(setDoomConfigValue(filePath, ['voice', 'engine'], 'bogus')).rejects.toThrow(
      'requires voice.engine to be one of',
    );
    expect(read()).toBe(original);
    expect(siblings()).toEqual([]);
  });

  it('refuses to overwrite malformed YAML', async () => {
    fs.writeFileSync(filePath, 'modes: [\n');
    await expect(setDoomConfigValue(filePath, ['editor', 'command'], 'vi {file}')).rejects.toThrow(
      'Could not parse Doom config',
    );
    expect(read()).toBe('modes: [\n');
    expect(siblings()).toEqual([]);
  });
});

describe('unsetDoomConfigValue', () => {
  it('is a no-op when an ancestor is missing', async () => {
    const original = 'projectTrust: ask\n';
    fs.writeFileSync(filePath, original);
    // deleteIn throws `Expected YAML collection at voice` rather than treating the
    // key as already absent, so the guard is what makes clearing safe.
    await expect(unsetDoomConfigValue(filePath, ['voice', 'engine'])).resolves.toBeUndefined();
    expect(read()).toBe(original);
  });

  it('prunes ancestors left empty rather than leaving an invalid adapter', async () => {
    fs.writeFileSync(
      filePath,
      'projectTrust: ask\nvoice:\n  adapters:\n    whisper-cpp:\n      model:\n        path: /models/a.bin\n',
    );
    await unsetDoomConfigValue(filePath, ['voice', 'adapters', 'whisper-cpp', 'model', 'path']);
    const output = read();
    // An adapter kept as `{}` fails parseAdapter, which requires a model.
    expect(output).not.toContain('whisper-cpp');
    expect(output).toContain('projectTrust: ask');
    expect(parseDoomConfig(output, filePath).voice).toBeUndefined();
  });

  it('stops pruning at the first ancestor that still holds something', async () => {
    fs.writeFileSync(filePath, 'voice:\n  engine: auto\n  recorder:\n    device: none:default\n');
    await unsetDoomConfigValue(filePath, ['voice', 'recorder', 'device']);
    const parsed = parseDoomConfig(read(), filePath);
    expect(parsed.voice?.recorder).toBeUndefined();
    expect(parsed.voice?.engine).toBe('auto');
  });
});

describe('writeDoomConfigValues edge cases', () => {
  it('does nothing when handed no edits', async () => {
    await writeDoomConfigValues(filePath, []);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('keeps an emptied ancestor when pruning is off', async () => {
    fs.writeFileSync(filePath, 'voice:\n  engine: auto\n  recorder:\n    device: none:default\n');
    await writeDoomConfigValues(filePath, [{ keyPath: ['voice', 'recorder', 'device'] }], { prune: false });
    expect(read()).toContain('recorder');
  });

  it('creates the parent directory for a config that does not exist yet', async () => {
    const nested = path.join(directory, 'nested', 'config.yaml');
    await setDoomConfigValue(nested, ['projectTrust'], 'always');
    expect(parseDoomConfig(fs.readFileSync(nested, 'utf8'), nested).projectTrust).toBe('always');
  });
});
