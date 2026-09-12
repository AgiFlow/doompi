import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compositionLayout } from '../../src/rules/compositionLayout.js';

const roots: string[] = [];
function fixture(relative: string, source = "export { service } from '../services/example';", adopted = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-layout-'));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      adopted
        ? {
            doompiServer: { entry: './src/extensions/server.ts' },
          }
        : {},
    ),
  );
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return { root, file };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('composition layout path bans', () => {
  it.each([
    'adapters/pi/index.ts',
    'container/index.ts',
    'containers/runtime.ts',
    'commands/open.ts',
    'providers/status.ts',
  ])('rejects src/%s even when it only forwards exports', (relative) => {
    const { root, file } = fixture(`src/${relative}`);
    expect(compositionLayout.check?.(file, root)).toContain('Forbidden composition path');
  });
  it('rejects nested public entries', () => {
    const { root, file } = fixture('src/exports/extensions/web.ts');
    expect(compositionLayout.check?.(file, root)).toContain('Nested export path');
  });
  it.each(['export const plugin = {};', "import { plugin } from '../extensions/server'; export { plugin };", ''])(
    'rejects executable or empty public entries',
    (source) => {
      const { root, file } = fixture('src/exports/service.ts', source);
      expect(compositionLayout.check?.(file, root)).toContain('forward shared public APIs only');
    },
  );
  it('accepts flat forwarding exports', () => {
    const { root, file } = fixture('src/exports/service.ts');
    expect(compositionLayout.check?.(file, root)).toBeNull();
  });
  it('rejects redundant extension re-exports', () => {
    const { root, file } = fixture('src/exports/server.ts', "export { plugin } from '../extensions/server';");
    expect(compositionLayout.check?.(file, root)).toContain('move extension entries into src/extensions');
  });
  it('rejects forbidden paths without adoption metadata', () => {
    const { root, file } = fixture('src/adapters/server.ts', 'export const plugin = {};', false);
    expect(compositionLayout.check?.(file, root)).toContain('Forbidden composition path');
  });
  it.each([
    'controllers/author.ts',
    'services/catalog/index.ts',
    'models/session.ts',
    'tools/author.ts',
    'extensions/server.ts',
  ])('accepts src/%s', (relative) => {
    const { root, file } = fixture(`src/${relative}`, 'export const implementation = {};');
    expect(compositionLayout.check?.(file, root)).toBeNull();
  });
});
