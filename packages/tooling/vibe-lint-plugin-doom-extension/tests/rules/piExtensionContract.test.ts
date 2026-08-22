import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { piExtensionDefaultFactory } from '../../src/rules/piExtensionContract.js';

const boundaryContext = () => ({ boundary: null });

describe('Pi extension default factory rule', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-pi-entry-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, source: string): string {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, 'utf8');
    return filePath;
  }

  function declareEntry(runtimePath = './dist/extensions/pi.mjs'): void {
    write(
      'package.json',
      JSON.stringify({
        pi: { extensions: [runtimePath] },
        exports: { './extensions/pi': { import: runtimePath } },
      }),
    );
  }

  it('accepts direct default function declarations', () => {
    declareEntry();
    const entry = write('src/exports/extensions/pi.ts', 'export default function activate(): void {}');

    expect(piExtensionDefaultFactory.check?.(entry, root, boundaryContext())).toBeNull();
  });

  it('accepts callable variables and alias chains as default exports', () => {
    declareEntry();
    const arrow = write(
      'src/exports/extensions/pi.ts',
      ['const activate = (): void => {};', 'const extension = activate;', 'export default extension;'].join('\n'),
    );
    expect(piExtensionDefaultFactory.check?.(arrow, root, boundaryContext())).toBeNull();

    const expression = write(
      'src/exports/extensions/pi.ts',
      ['const activate = function (): void {};', 'export { activate as default };'].join('\n'),
    );
    expect(piExtensionDefaultFactory.check?.(expression, root, boundaryContext())).toBeNull();
  });

  it('accepts imported and forwarded default factories', () => {
    declareEntry();
    const imported = write(
      'src/exports/extensions/pi.ts',
      ["import activate from '../../extensions/activate.js';", 'export default activate;'].join('\n'),
    );
    expect(piExtensionDefaultFactory.check?.(imported, root, boundaryContext())).toBeNull();

    const forwarded = write(
      'src/exports/extensions/pi.ts',
      "export { activate as default } from '../../extensions/activate.js';",
    );
    expect(piExtensionDefaultFactory.check?.(forwarded, root, boundaryContext())).toBeNull();
  });

  it('accepts factory creator calls and rejects non-callable defaults', () => {
    declareEntry();
    const call = write(
      'src/exports/extensions/pi.ts',
      ["import { createExtension } from '../../extensions/create.js';", 'export default createExtension();'].join('\n'),
    );
    expect(piExtensionDefaultFactory.check?.(call, root, boundaryContext())).toBeNull();

    const value = write('src/exports/extensions/pi.ts', "export default 'not-a-factory';");
    expect(piExtensionDefaultFactory.check?.(value, root, boundaryContext())).toContain('callable default factory');
  });

  it('rejects cyclic aliases that never resolve to a callable', () => {
    declareEntry();
    const entry = write(
      'src/exports/extensions/pi.ts',
      ['const first = second;', 'const second = first;', 'export default first;'].join('\n'),
    );

    expect(piExtensionDefaultFactory.check?.(entry, root, boundaryContext())).toContain('callable default factory');
  });

  it('recognizes conventional entries by ExtensionAPI imports', () => {
    const entry = write(
      'src/exports/entries/notifications.ts',
      [
        "import type { ExtensionAPI as HostApi } from '@earendil-works/pi-coding-agent';",
        'export function notifications(_pi: HostApi): void {}',
      ].join('\n'),
    );

    expect(piExtensionDefaultFactory.check?.(entry, root, boundaryContext())).toContain('callable default factory');
  });

  it('ignores helpers, unsupported files, missing files, and paths outside the config root', () => {
    const helper = write('src/exports/entries/helper.ts', 'export const helper = true;');
    const json = write('src/exports/extensions/pi.json', '{}');
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`);
    fs.writeFileSync(outside, 'export const outside = true;', 'utf8');

    expect(piExtensionDefaultFactory.check?.(helper, root, boundaryContext())).toBeNull();
    expect(piExtensionDefaultFactory.check?.(json, root, boundaryContext())).toBeNull();
    expect(piExtensionDefaultFactory.check?.(path.join(root, 'missing.ts'), root, boundaryContext())).toBeNull();
    expect(piExtensionDefaultFactory.check?.(outside, root, boundaryContext())).toBeNull();
    fs.rmSync(outside, { force: true });
  });
});
