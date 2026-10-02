import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertSupportedDesktopTarget,
  bundledDoomPiPackages,
  DOOMPI_RUNTIME_PACKAGES,
  isExternalRuntimePackage,
} from '../../scripts/desktopRuntimePlugin';
import runtimeConfig from '../../vite.runtime.config';

describe('desktop release targets', () => {
  it.each(['darwin-arm64', 'linux-x64', 'linux-arm64'])('accepts %s', (target) => {
    expect(() => assertSupportedDesktopTarget(target)).not.toThrow();
  });

  it.each(['win32-x64', 'darwin-x64', 'linux-ia32'])('rejects %s', (target) => {
    expect(() => assertSupportedDesktopTarget(target)).toThrow(/not supported/u);
  });
});

describe('desktop runtime externals', () => {
  it('keeps Pi imports on the staged package instance', () => {
    expect(isExternalRuntimePackage('@earendil-works/pi-coding-agent')).toBe(true);
    expect(isExternalRuntimePackage('@earendil-works/pi-coding-agent/client')).toBe(true);
  });

  it('keeps SQLite migration URLs relative to their staged owning package', () => {
    expect(isExternalRuntimePackage('@earendil-works/pi-session-backend-sqlite-node')).toBe(true);
  });
  it('continues bundling unrelated dependencies', () => {
    expect(isExternalRuntimePackage('@earendil-works/pi-server')).toBe(false);
  });

  it('stages the peer required by the coding agent server entry', () => {
    expect(DOOMPI_RUNTIME_PACKAGES).toContain('@earendil-works/pi-server');
  });
});

describe('desktop DoomPi entrypoints', () => {
  it('keeps every staged entry on an existing source file', () => {
    const input = runtimeConfig.build?.rollupOptions?.input;
    expect(input).toBeDefined();
    for (const entry of Object.values(input ?? {})) {
      expect(fs.existsSync(entry), `Missing staged entry: ${entry}`).toBe(true);
    }
  });

  it('stages the entries needed to sync a repository', () => {
    expect(runtimeConfig).toMatchObject({
      build: {
        rollupOptions: {
          input: {
            'doompi/dist/extensions/agentModel': expect.any(String),
            'doompi/dist/extensions/composedPi': expect.any(String),
            'doompi/dist/builders/cli/index': expect.any(String),
            'doompi/dist/extensions/styleSystem': expect.any(String),
          },
        },
      },
    });
  });
});

describe('desktop DoomPi package catalog', () => {
  it('includes selectable layer packages', () => {
    const workspaceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
    const names = bundledDoomPiPackages(workspaceRoot, `${process.platform}-${process.arch}`).map(
      (entry) => entry.name,
    );

    expect(names).toEqual(
      expect.arrayContaining([
        '@agimon-ai/doompi-computer-use',
        `@agimon-ai/doompi-runner-rmux-${process.platform}-${process.arch}`,
        `@agimon-ai/doompi-runner-rtk-${process.platform}-${process.arch}`,
        '@agimon-ai/doompi-sandbox',
        '@agimon-ai/doompi-task',
        '@agimon-ai/doompi-team',
        '@agimon-ai/doompi-user-feedback',
      ]),
    );
  });
});
