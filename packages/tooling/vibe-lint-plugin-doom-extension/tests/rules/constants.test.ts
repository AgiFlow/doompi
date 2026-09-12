import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doomConstants } from '../../src/rules/constants.js';
import { doomFolderLayout, doomLayerBoundary } from '../../src/rules/architecture.js';
import { webPluginImportAllowlist } from '../../src/rules/webPlugin.js';

describe('constants ownership', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-constants-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(relative: string, text: string) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }
  it.each([
    'COMMAND_NAME',
    'COMMAND_DESCRIPTION',
    'AUTHOR_COMMAND_NAME',
    'AUTHOR_COMMAND_DESCRIPTION',
    'AUTHOR_GUIDANCE',
  ])('rejects inline %s', (name) => {
    expect(doomConstants.check!(write('src/extensions/server.ts', `const ${name} = 'author';`), root)).toContain(
      'src/constants',
    );
  });
  it('allows generic schema values and local variables', () => {
    expect(
      doomConstants.check!(
        write('src/schemas/protocol.ts', "const PROTOCOL_VERSION = 2; function f() { const COMMAND_NAME = 'local'; }"),
        root,
      ),
    ).toBeNull();
  });
  it('accepts reusable data in the lowest layer', () => {
    const file = write(
      'src/constants/author.ts',
      "import { NAME } from './names.ts'; export const AUTHOR_COMMAND_NAME = NAME; export const AUTHOR_GUIDANCE = 'Use tools'; export const OPTIONS = { enabled: true, names: [NAME] } as const;",
    );
    expect(doomConstants.check!(file, root)).toBeNull();
    expect(doomFolderLayout.check!(file, root)).toBeNull();
    expect(doomLayerBoundary.check!(file, root)).toBeNull();
  });
  it('allows data-only arithmetic, constant member access, and array composition', () => {
    const file = write(
      'src/constants/bounds.ts',
      `
      import { LIMIT, NAMES, ERRORS } from './shared';
      export const BYTES = 64 * 1024;
      export const BOUND = (LIMIT + 2) / 2;
      export const TOOLS = [...NAMES, 'extra'];
      export const ERROR = ERRORS.unavailable;
    `,
    );
    expect(doomConstants.check!(file, root)).toBeNull();
  });
  it.each([
    'call().value',
    '[...call()]',
    '1 + call()',
    'count += 1',
    'left && right',
    '() => 1',
    '{ get value() { return 1; } }',
  ])('rejects executable expressions within data composition: %s', (expression) => {
    expect(
      doomConstants.check!(write('src/constants/invalid.ts', `export const DATA = ${expression};`), root),
    ).not.toBeNull();
  });
  it.each([
    "import { service } from '../services/service.ts';",
    "export { value } from '../schemas/value.ts';",
    "import path from 'node:path';",
    "export const NAME = String('name');",
    'export const factory = () => 1;',
    'export function run() {}',
    'export let NAME = 1;',
    'export interface Port {}',
  ])('rejects implementation or higher dependencies: %s', (source) => {
    expect(doomConstants.check!(write('src/constants/invalid.ts', source), root)).not.toBeNull();
  });
  it.each(['extensions', 'controllers', 'models', 'tools', 'schemas', 'services', 'tui', 'types', 'web', 'bin'])(
    'allows %s to consume constants',
    (layer) => {
      const file = write(
        `src/${layer}/consumer.ts`,
        "import { NAME } from '../constants/names.ts'; export const value = NAME;",
      );
      expect(doomLayerBoundary.check!(file, root)).toBeNull();
    },
  );
  it('allows browser imports of constants', () => {
    write(
      'package.json',
      JSON.stringify({ name: '@agimon-ai/doompi-demo', doompiWeb: { client: './src/extensions/web.ts' } }),
    );
    const file = write('src/web/consumer.ts', "import { NAME } from '../constants/names.ts';");
    expect(webPluginImportAllowlist.check!(file, root)).toBeNull();
  });
});
