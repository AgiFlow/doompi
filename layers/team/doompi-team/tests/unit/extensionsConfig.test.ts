import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getConfigPath, loadConfig, saveConfig, updateConfig } from '../../src/adapters/pi/extensions/config';

const temporaryDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-extensions-config-'));
  temporaryDirs.push(dir);
  return dir;
}

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('getConfigPath', () => {
  it('resolves under the agent dir, in extensions/subagent/config.json', () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    expect(getConfigPath()).toBe(path.join(agentDir, 'extensions', 'subagent', 'config.json'));
  });
});

describe('saveConfig real disk write', () => {
  it('saves a config, creating parent directories, and it reads back byte-identical', () => {
    const configPath = path.join(makeTempDir(), 'nested', 'config.json');

    saveConfig({ maxSubagentDepth: 3 }, configPath);

    expect(fs.existsSync(configPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw).toEqual({ maxSubagentDepth: 3 });
  });
});

describe('updateConfig real disk round-trip', () => {
  it('starts from {} and persists when no file exists yet', () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const expectedPath = path.join(agentDir, 'extensions', 'subagent', 'config.json');

    const result = updateConfig((config) => ({ ...config, maxSubagentDepth: 5 }));

    expect(result).toEqual({ maxSubagentDepth: 5 });
    expect(JSON.parse(fs.readFileSync(expectedPath, 'utf-8'))).toEqual({ maxSubagentDepth: 5 });
  });

  it('merges onto an existing config rather than replacing it', () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    updateConfig(() => ({ maxSubagentDepth: 3, artifactDir: 'project' }));

    const result = updateConfig((config) => ({ ...config, maxSubagentDepth: 7 }));

    expect(result).toEqual({ maxSubagentDepth: 7, artifactDir: 'project' });
  });

  it('a config file with an unrecognized field round-trips it untouched', () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ fleetView: true, maxSubagentDepth: 2 }));

    const result = updateConfig((config) => ({ ...config, maxSubagentDepth: 9 }));

    expect(result).toMatchObject({ maxSubagentDepth: 9, fleetView: true });
  });
});

describe('loadConfig', () => {
  it('returns {} with no loadError when no config file exists', () => {
    process.env.PI_CODING_AGENT_DIR = makeTempDir();

    expect(loadConfig()).toEqual({ config: {} });
  });

  it('returns the real, parsed config when one exists', () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    saveConfig({ maxSubagentDepth: 4 }, getConfigPath());

    expect(loadConfig()).toEqual({ config: { maxSubagentDepth: 4 } });
  });

  it('never throws for a malformed (non-JSON) config file - reports loadError instead', () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{not valid json');

    const result = loadConfig();

    expect(result.config).toEqual({});
    expect(result.loadError).toMatch(/Failed to load subagent config/);
  });

  it('reports loadError for a config file that is valid JSON but not an object', () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify([1, 2, 3]));

    const result = loadConfig();

    expect(result.config).toEqual({});
    expect(result.loadError).toMatch(/must be a JSON object/);
  });

  it('reports loadError for an invalid artifactDir value', () => {
    const agentDir = makeTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ artifactDir: 'nowhere' }));

    const result = loadConfig();

    expect(result.loadError).toMatch(/artifactDir must be "project", "session", or "temp"/);
  });

  it('accepts every valid artifactDir value', () => {
    for (const value of ['project', 'session', 'temp']) {
      const agentDir = makeTempDir();
      process.env.PI_CODING_AGENT_DIR = agentDir;
      saveConfig({ artifactDir: value as 'project' | 'session' | 'temp' }, getConfigPath());

      expect(loadConfig()).toEqual({ config: { artifactDir: value } });
    }
  });
});
