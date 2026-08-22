import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompatibilityOptions } from '../../../src/types/interfaces/compatibility';
import {
  codexEnvironment,
  codexPluginDirectories,
  launchCodex,
} from '../../../src/exports/services/compatibility/codex';
import type { CompatibilityContext } from '../../../src/exports/services/compatibilityContext';

/** Writes an executable shell stub so the launcher resolves it from PATH. */
function writeStub(binDirectory: string, name: string, body: string): void {
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(path.join(binDirectory, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

describe('codex compatibility', () => {
  let root: string;
  let binDirectory: string;
  let executablePath: string;

  function context(overrides: Partial<CompatibilityContext> = {}): CompatibilityContext {
    const options: CompatibilityOptions = {
      repoRoot: root,
      currentDirectory: root,
      provider: 'codex',
      domains: ['default', 'qa'],
      majorMode: 'copilot',
      providerArgs: [],
      additionalDirectories: [],
      skipPermissions: false,
    };
    return {
      options,
      environment: { HOME: path.join(root, 'home'), PATH: executablePath },
      plugins: [{ directory: path.join(root, 'plugins', 'shared') }],
      mcpConfigPath: path.join(root, 'mcp.json'),
      proxyConfigPath: path.join(root, 'mcp-config.yaml'),
      selectedLayers: ['guardrails'],
      hookGroups: ['guardrails'],
      sharedSkills: true,
      cleanup: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-codex-'));
    binDirectory = path.join(root, 'bin');
    executablePath = `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
    fs.mkdirSync(path.join(root, 'plugins', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tools', 'harness'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('codexPluginDirectories', () => {
    it('reduces repository plugins to their directory name', () => {
      expect(codexPluginDirectories(context())).toEqual(['shared']);
    });

    it('rejects a plugin outside the repository plugins directory', () => {
      const outside = path.join(root, 'vendor', 'external');

      expect(() => codexPluginDirectories(context({ plugins: [{ directory: outside }] }))).toThrow(
        'Codex compatibility requires a direct repository plugin',
      );
    });

    it('rejects a plugin nested below the plugins directory', () => {
      const nested = path.join(root, 'plugins', 'group', 'inner');

      expect(() => codexPluginDirectories(context({ plugins: [{ directory: nested }] }))).toThrow(
        'Codex compatibility requires a direct repository plugin',
      );
    });

    it('rejects the plugins directory itself', () => {
      expect(() => codexPluginDirectories(context({ plugins: [{ directory: path.join(root, 'plugins') }] }))).toThrow(
        'Codex compatibility requires a direct repository plugin',
      );
    });
  });

  describe('codexEnvironment', () => {
    it('records the git origin, domains, and plugin directories', () => {
      writeStub(binDirectory, 'git', 'echo git@example.com:acme/repo.git');
      writeStub(binDirectory, 'xcrun', 'exit 0');

      const environment = codexEnvironment(context());

      expect(environment.CODEX_REPO_ORIGIN).toBe('git@example.com:acme/repo.git');
      expect(environment.CODEX_PROFILE_NAMES).toBe('default,qa');
      expect(environment.CODEX_PLUGIN_DIRS).toBe('shared');
      expect(environment.CODEX_ENABLE_XCODE_MCP).toBe('1');
    });

    it('leaves the origin empty for a repository with no remote', () => {
      writeStub(binDirectory, 'git', 'exit 128');
      writeStub(binDirectory, 'xcrun', 'exit 1');

      const environment = codexEnvironment(context());

      expect(environment.CODEX_REPO_ORIGIN).toBe('');
      expect(environment.CODEX_ENABLE_XCODE_MCP).toBe('0');
    });
  });

  describe('launchCodex', () => {
    function writeSyncScript(profileConfigName: unknown): void {
      fs.writeFileSync(
        path.join(root, 'tools', 'harness', 'sync-codex-state.cjs'),
        [
          'const mode = process.argv[2];',
          "if (mode === 'owner-key') { process.stdout.write('acme-repo'); }",
          `else { process.stdout.write(JSON.stringify({ profileConfigName: ${JSON.stringify(profileConfigName)} })); }`,
          '',
        ].join('\n'),
      );
    }

    beforeEach(() => {
      writeStub(binDirectory, 'git', 'echo origin-url');
      writeStub(binDirectory, 'xcrun', 'exit 1');
      writeStub(binDirectory, 'npx', 'exit 0');
    });

    it('prestarts the proxy, syncs state, and launches with the managed profile', async () => {
      writeSyncScript('acme_profile');
      writeStub(binDirectory, 'codex', 'if [ "$1" = "--help" ]; then echo "--profile-v2 available"; fi\nexit 0');

      await expect(launchCodex(context())).resolves.toBe(0);
    });

    it('points CODEX_HOME at the synced state name under the user home', async () => {
      writeSyncScript('acme_profile');
      // Record the environment the launched child receives.
      const captured = path.join(root, 'captured-env');
      writeStub(
        binDirectory,
        'codex',
        `if [ "$1" = "--help" ]; then echo "--profile"; exit 0; fi\nprintenv CODEX_HOME > ${captured}\nexit 0`,
      );

      await expect(launchCodex(context())).resolves.toBe(0);

      expect(fs.readFileSync(captured, 'utf8').trim()).toBe(path.join(root, 'home', '.codex', 'acme-repo'));
    });

    it('falls back to a repository-local state directory when HOME is unset', { timeout: 15_000 }, async () => {
      writeSyncScript('acme_profile');
      const captured = path.join(root, 'captured-env');
      writeStub(
        binDirectory,
        'codex',
        `if [ "$1" = "--help" ]; then echo "--profile"; exit 0; fi\nprintenv CODEX_HOME > ${captured}\nexit 0`,
      );

      await expect(launchCodex(context({ environment: { PATH: executablePath } }))).resolves.toBe(0);

      expect(fs.readFileSync(captured, 'utf8').trim()).toBe(path.join(root, '.codex-local', 'state', 'acme-repo'));
    });

    it('rejects a sync result whose profile name is not a safe identifier', async () => {
      writeSyncScript('../escape');
      writeStub(binDirectory, 'codex', 'exit 0');

      await expect(launchCodex(context())).rejects.toThrow('Codex sync returned an invalid profile config name');
    });

    it('rejects a sync result with no usable profile name', async () => {
      writeSyncScript(42);
      writeStub(binDirectory, 'codex', 'exit 0');

      await expect(launchCodex(context())).rejects.toThrow('Codex sync returned an invalid profile config name');
    });

    it('propagates a failure from the proxy prestart', async () => {
      writeSyncScript('acme_profile');
      writeStub(binDirectory, 'npx', 'exit 9');
      writeStub(binDirectory, 'codex', 'exit 0');

      await expect(launchCodex(context())).rejects.toThrow('exited with status 9');
    });

    it('surfaces the child exit code', async () => {
      writeSyncScript('acme_profile');
      writeStub(binDirectory, 'codex', 'if [ "$1" = "--help" ]; then echo "--profile"; exit 0; fi\nexit 6');

      await expect(launchCodex(context())).resolves.toBe(6);
    });
  });
});
