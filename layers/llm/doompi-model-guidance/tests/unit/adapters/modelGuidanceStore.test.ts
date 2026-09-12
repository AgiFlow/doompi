import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadModelGuidance } from '../../../src/services/modelGuidanceStore';
import { DEFAULT_MODEL_GUIDANCE_PRESET, mergeModelGuidance } from '../../../src/services/modelGuidance';

const defaultGuidance = mergeModelGuidance([DEFAULT_MODEL_GUIDANCE_PRESET]);
let workspace: string;
let repositoryRoot: string;
let homeDirectory: string;

function writeGlobal(contents: string): void {
  const directory = path.join(homeDirectory, '.pi', '.doom');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'model-guidance.yaml'), contents, 'utf8');
}

function writeRepository(contents: string): void {
  const directory = path.join(repositoryRoot, '.doom');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'model-guidance.yaml'), contents, 'utf8');
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'model-guidance-'));
  repositoryRoot = path.join(workspace, 'repository');
  homeDirectory = path.join(workspace, 'home');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  fs.mkdirSync(homeDirectory, { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadModelGuidance', () => {
  it('returns the built-in default when the repository root is unknown', () => {
    expect(loadModelGuidance(undefined, homeDirectory)).toEqual(defaultGuidance);
  });

  it('returns the built-in default when neither document exists', () => {
    expect(loadModelGuidance(repositoryRoot, homeDirectory)).toEqual(defaultGuidance);
  });

  it('merges the global document over the built-in default', () => {
    writeGlobal('modelGuidance:\n  claude-opus-5: Stay focused.\n');
    expect(loadModelGuidance(repositoryRoot, homeDirectory)).toEqual({
      ...defaultGuidance,
      'claude-opus-5': 'Stay focused.',
    });
  });

  it('reads the repository document alone', () => {
    writeRepository('modelGuidance:\n  gpt-6-astra: Batch tools.\n');
    expect(loadModelGuidance(repositoryRoot, homeDirectory)).toEqual({ 'gpt-6-astra': 'Batch tools.' });
  });

  it('lets the repository win one model id while other global ids survive', () => {
    writeGlobal('modelGuidance:\n  claude-opus-5: Stay focused.\n  gpt-6-astra: Batch tools.\n');
    writeRepository('modelGuidance:\n  claude-opus-5: Cordis rules apply.\n');

    expect(loadModelGuidance(repositoryRoot, homeDirectory)).toEqual({
      'claude-opus-5': 'Cordis rules apply.',
      'gpt-6-astra': 'Batch tools.',
    });
  });

  it('preserves newlines from a block scalar', () => {
    writeRepository('modelGuidance:\n  m: |\n    First line.\n    Second line.\n');
    expect(loadModelGuidance(repositoryRoot, homeDirectory).m).toBe('First line.\nSecond line.');
  });

  it('treats an empty document as absent', () => {
    writeGlobal('');
    writeRepository('modelGuidance:\n  m: Kept.\n');
    expect(loadModelGuidance(repositoryRoot, homeDirectory)).toEqual({ ...defaultGuidance, m: 'Kept.' });
  });

  it('fails open on malformed YAML, warning on stderr instead of throwing', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeRepository('modelGuidance:\n  m: "unterminated\n   : : :\n');

    expect(() => loadModelGuidance(repositoryRoot, homeDirectory)).not.toThrow();
    expect(loadModelGuidance(repositoryRoot, homeDirectory)).toEqual(defaultGuidance);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('doompi-model-guidance'));
  });
});
