import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { neutralExtensionContracts } from '../../src/rules/neutralContracts.js';

const roots: string[] = [];
function fixture(source: string, relative = 'src/schemas/protocol.ts', name = '@agimon-ai/doompi-core') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-contracts-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }));
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return { root, file };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('neutral extension contracts', () => {
  it('accepts neutral registration schemas', () => {
    const { root, file } = fixture('export interface PluginMethod { service: string; method: string }');
    expect(neutralExtensionContracts.check?.(file, root)).toBeNull();
  });
  it('accepts generic payload vocabulary without treating it as package ownership', () => {
    const { root, file } = fixture('export interface Operation { goal: string; runner: string; }');
    expect(neutralExtensionContracts.check?.(file, root)).toBeNull();
  });
  it('rejects feature tool names even inside a generically named file', () => {
    const { root, file } = fixture("export const AUTHOR_USE_TOOL_NAME = 'use_author_tools';");
    expect(neutralExtensionContracts.check?.(file, root)).toContain('feature symbol AUTHOR_USE_TOOL_NAME');
  });
  it('rejects feature file patterns', () => {
    const { root, file } = fixture('export type Input = {};', 'src/schemas/authorFacade.ts');
    expect(neutralExtensionContracts.check?.(file, root)).toContain('feature file');
  });
  it('rejects type-only dependencies on feature packages', () => {
    const { root, file } = fixture("export type { Input } from '@agimon-ai/doompi-author/author-facade';");
    expect(neutralExtensionContracts.check?.(file, root)).toContain('feature dependency');
  });
  it('rejects feature manifest exports and dependencies', () => {
    const { root, file } = fixture(
      JSON.stringify({
        name: '@agimon-ai/doompi-core',
        dependencies: { '@agimon-ai/doompi-author': 'workspace:*' },
        exports: { './author-facade': './dist/author.mjs' },
      }),
      'package.json',
    );
    expect(neutralExtensionContracts.check?.(file, root)).toContain('feature export');
    expect(neutralExtensionContracts.check?.(file, root)).toContain('feature dependency');
  });
  it('allows feature-owned schemas in their owner', () => {
    const { root, file } = fixture(
      "export const AUTHOR_USE_TOOL_NAME = 'use_author_tools';",
      'src/schemas/authorFacade.ts',
      '@agimon-ai/doompi-author',
    );
    expect(neutralExtensionContracts.check?.(file, root)).toBeNull();
  });
});
