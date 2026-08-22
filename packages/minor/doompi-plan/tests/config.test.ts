import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalDoomConfigPath, loadDoomConfig, parseDoomConfig, repositoryDoomConfigPath } from '../src/exports/config';

let homeDirectory: string;
let repoRoot: string;

function writeConfig(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

beforeEach(() => {
  vi.clearAllMocks();
  homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-home-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-repo-'));
});

afterEach(() => {
  fs.rmSync(homeDirectory, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('Doom config paths', () => {
  it('uses the requested global and repository locations', () => {
    expect(globalDoomConfigPath(homeDirectory)).toBe(path.join(homeDirectory, '.pi', '.doom', 'config.yaml'));
    expect(repositoryDoomConfigPath(repoRoot)).toBe(path.join(repoRoot, '.doom', 'config.yaml'));
  });
});

describe('loadDoomConfig', () => {
  it('returns an empty config when neither layer exists', () => {
    expect(loadDoomConfig(repoRoot, homeDirectory)).toEqual({});
  });

  it('deep merges repository fields over global planning fields', () => {
    writeConfig(
      globalDoomConfigPath(homeDirectory),
      `modes:
  planning:
    main:
      model: openai-codex/global-main
      thinking: high
    subagents:
      model: openai-codex/global-child
      thinking: medium
`,
    );
    writeConfig(
      repositoryDoomConfigPath(repoRoot),
      `modes:
  planning:
    main:
      thinking: max
    subagents:
      model: anthropic/repo-child
`,
    );

    expect(loadDoomConfig(repoRoot, homeDirectory)).toEqual({
      modes: {
        planning: {
          main: { model: 'openai-codex/global-main', thinking: 'max' },
          subagents: { model: 'anthropic/repo-child', thinking: 'medium' },
        },
      },
    });
  });

  it('reports which file contains invalid planning config', () => {
    const filePath = repositoryDoomConfigPath(repoRoot);
    writeConfig(filePath, 'modes:\n  planning:\n    main:\n      thinking: extreme\n');

    expect(() => loadDoomConfig(repoRoot, homeDirectory)).toThrow(`${filePath} requires modes.planning.main.thinking`);
  });
});

describe('parseDoomConfig', () => {
  it('accepts the Doom Pi project trust field in the shared config file', () => {
    expect(parseDoomConfig('projectTrust: always\n', '/tmp/config.yaml')).toEqual({});
  });

  it('keeps plan mode loadable when the shared config contains an editor command', () => {
    expect(parseDoomConfig('editor:\n  command: nvim +{line} {file}\n', '/tmp/config.yaml')).toEqual({});
  });

  it('rejects unsupported fields instead of silently ignoring typos', () => {
    expect(() => parseDoomConfig('modes:\n  planning:\n    children: {}\n', '/tmp/config.yaml')).toThrow(
      'unsupported modes.planning field(s): children',
    );
  });

  it('rejects a non-object YAML root', () => {
    expect(() => parseDoomConfig('- planning\n', '/tmp/config.yaml')).toThrow('must be a YAML object');
  });
});
