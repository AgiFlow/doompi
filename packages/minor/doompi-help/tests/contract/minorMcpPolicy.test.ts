import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface MinorPackageManifest {
  doompiMcp?: unknown;
  scripts?: Record<string, string>;
}

const minorPackagesDirectory = fileURLToPath(new URL('../../..', import.meta.url));
const remoteMcpAllowlist = new Set(['doompi-computer-use', 'doompi-plan']);

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

describe('minor package remote MCP policy', () => {
  it('allows only computer-use and plan to expose remote tools or skills', async () => {
    const entries = await readdir(minorPackagesDirectory, { withFileTypes: true });
    const violations: Record<string, string[]> = {};

    for (const entry of entries) {
      if (!entry.isDirectory() || remoteMcpAllowlist.has(entry.name)) continue;
      const packageDirectory = path.join(minorPackagesDirectory, entry.name);
      const manifest = JSON.parse(
        await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
      ) as MinorPackageManifest;
      const sourceFiles = await readdir(path.join(packageDirectory, 'src'), { recursive: true });
      const exposure = [
        ...(manifest.doompiMcp === undefined ? [] : ['doompiMcp metadata']),
        ...(manifest.scripts?.['build:mcp'] === undefined ? [] : ['build:mcp script']),
        ...(Object.values(manifest.scripts ?? {}).some((command) => command.includes('tsdown.mcp.config.ts'))
          ? ['MCP build invocation']
          : []),
        ...((await exists(path.join(packageDirectory, 'tsdown.mcp.config.ts'))) ? ['MCP build config'] : []),
        ...(sourceFiles.some((file) => file.endsWith('.mcp.ts')) ? ['MCP registration'] : []),
        ...((await exists(path.join(packageDirectory, 'src/services/mcpTools'))) ? ['remote tool adapter'] : []),
      ];
      if (exposure.length > 0) violations[entry.name] = exposure;
    }

    expect(violations).toEqual({});
  });
});
