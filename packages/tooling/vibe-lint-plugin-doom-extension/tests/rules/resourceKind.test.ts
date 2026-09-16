import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { doomResourceKind } from '../../src/rules/resourceKind.js';

const boundaryContext = () => ({ boundary: null });

describe('Doom resource kind rule', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-resource-kind-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, source: string): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, 'utf8');
  }

  function check(): string | null {
    const manifest = path.join(root, 'package.json');
    fs.writeFileSync(manifest, JSON.stringify({ name: 'fixture' }), 'utf8');
    return doomResourceKind.check!(manifest, root, boundaryContext() as never) as string | null;
  }

  it('accepts live session state registered as context', () => {
    write(
      'src/extensions/state.server.ts',
      `export default { name: 'doompi/config', kind: 'context' as const, read: (x) => JSON.stringify(x.selection) };`,
    );
    expect(check()).toBeNull();
  });

  it('accepts a shipped file registered as a skill', () => {
    write(
      'src/extensions/skill.server.ts',
      `export default { name: 'doompi-use-fixture', kind: 'skill' as const, path: '/a/SKILL.md', read: () => readPackageResource(import.meta.url, 'src/prompts/doompi-use-fixture/SKILL.md') };`,
    );
    expect(check()).toBeNull();
  });

  it('accepts a shipped index kept out of the default prompt by a when gate', () => {
    write(
      'src/extensions/index.server.ts',
      `export default {
        when: { state: { 'minor-mode': 'help' }, attribution: { kind: 'minor', mode: 'help' } },
        name: 'doompi-fixture',
        kind: 'context' as const,
        read: () => readPackageResource(import.meta.url, 'llms.txt'),
      };`,
    );
    expect(check()).toBeNull();
  });

  it('rejects a shipped file registered as eager context', () => {
    write(
      'src/extensions/readme.server.ts',
      `export default { name: 'fixture-readme', kind: 'context' as const, read: () => readPackageResource(import.meta.url, 'README.md') };`,
    );
    expect(check()).toContain("kind 'context' reads a shipped file");
  });

  it('rejects a private package-root walk and its placeholder text', () => {
    write(
      'src/services/packageResources/index.ts',
      `const PACKAGE_ROOT = new URL('../../../', import.meta.url);\nexport async function read(name) {\n  try { return await readFile(new URL(name, PACKAGE_ROOT), 'utf8'); } catch { return \`(resource unavailable: \${name})\`; }\n}`,
    );
    expect(check()).toContain('@agimon-ai/doompi-core/server-facet');
  });
});
