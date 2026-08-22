import { globalDoomConfigPath } from '@agimon-ai/doompi-config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorConfigService } from '../src/adapters/EditorConfigService/EditorConfigService.ts';

/** The real service reads real config files; point both sources at temp files. */
class TestEditorConfigService extends EditorConfigService {
  constructor(
    private readonly testPath: string,
    private readonly testPackagePath = testPath,
  ) {
    super();
  }
  override path(): string {
    return this.testPath;
  }
  override packagePath(): string {
    return this.testPackagePath;
  }
}

let directory: string;
let filePath: string;
let service: TestEditorConfigService;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-file-edit-config-'));
  filePath = path.join(directory, 'config.yaml');
  service = new TestEditorConfigService(filePath);
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('EditorConfigService', () => {
  it('prefers the shared Doom config and keeps the Pi agent directory as fallback', () => {
    const service = new EditorConfigService();
    expect(service.path()).toBe(globalDoomConfigPath());
    expect(service.packagePath()).toBe(path.join(os.homedir(), '.pi', 'agent', 'doom-file-edit', 'config.yaml'));
  });

  it('falls back to the package config when the Doom config has no editor section', async () => {
    const packagePath = path.join(directory, 'package-config.yaml');
    const fallback = new TestEditorConfigService(filePath, packagePath);
    fs.writeFileSync(filePath, 'projectTrust: ask\n');
    fs.writeFileSync(packagePath, 'editor:\n  command: hx {file}\n');
    expect(await fallback.command()).toBe('hx {file}');
  });

  it('lets the Doom config win over the package config', async () => {
    const packagePath = path.join(directory, 'package-config.yaml');
    const both = new TestEditorConfigService(filePath, packagePath);
    fs.writeFileSync(filePath, 'editor:\n  command: nvim {file}\n');
    fs.writeFileSync(packagePath, 'editor:\n  command: hx {file}\n');
    expect(await both.command()).toBe('nvim {file}');
  });

  it('returns the configured command', async () => {
    fs.writeFileSync(filePath, 'editor:\n  command: nvim +{line} {file}\n');
    expect(await service.command()).toBe('nvim +{line} {file}');
  });

  it('returns nothing when the file is absent or has no editor section', async () => {
    expect(await service.command()).toBeUndefined();
    fs.writeFileSync(filePath, 'projectTrust: ask\n');
    expect(await service.command()).toBeUndefined();
  });

  it('surfaces a malformed config rather than reporting no command', async () => {
    // Reporting undefined here would silently fall back to $EDITOR and hide the
    // fact that the user's config never loaded.
    fs.writeFileSync(filePath, 'editor:\n  command: 42\n');
    await expect(service.command()).rejects.toThrow('editor.command');
  });
});
