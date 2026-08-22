import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectTrust, loadDoomConfig } from '../../src/exports/config/projectTrust';

describe('Doom Pi project trust', () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-project-trust-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps Pi project trust prompts when config is missing', () => {
    expect(loadDoomConfig(root)).toEqual({ projectTrust: 'ask' });
    expect(applyProjectTrust([], loadDoomConfig(root))).toEqual([]);
  });

  it('pre-approves new repository folders when configured', () => {
    fs.mkdirSync(path.join(root, '.doom'));
    fs.writeFileSync(path.join(root, '.doom', 'config.yaml'), 'projectTrust: always\n');

    expect(loadDoomConfig(root)).toEqual({ projectTrust: 'always' });
    expect(applyProjectTrust(['--thinking', 'low'], loadDoomConfig(root))).toEqual(['--approve', '--thinking', 'low']);
  });

  it('supports explicit distrust and preserves command-line overrides', () => {
    expect(applyProjectTrust(['--model', 'test'], { projectTrust: 'never' })).toEqual([
      '--no-approve',
      '--model',
      'test',
    ]);
    expect(applyProjectTrust(['--no-approve'], { projectTrust: 'always' })).toEqual(['--no-approve']);
    expect(applyProjectTrust(['--approve'], { projectTrust: 'never' })).toEqual(['--approve']);
  });

  it.each(['sometimes', 'null'])('rejects unsupported project trust value %s', (value) => {
    fs.mkdirSync(path.join(root, '.doom'));
    fs.writeFileSync(path.join(root, '.doom', 'config.yaml'), `projectTrust: ${value}\n`);

    expect(() => loadDoomConfig(root)).toThrow('projectTrust must be ask, always, or never');
  });
});
