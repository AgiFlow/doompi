import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noRawThemeColor } from '../../src/rules/theming.js';

describe('No raw theme colour rule', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-theming-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function check(relativePath: string, source: string): string | null | undefined {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, 'utf8');
    return noRawThemeColor.check?.(filePath, root);
  }

  it('accepts token classes and CSS custom properties', () => {
    const result = check(
      'src/web/features/session/ToolCard.tsx',
      [
        "const card = 'rounded-md border border-doom-edge-red bg-doom-tint-yellow text-doom-hi';",
        "const shadow = 'var(--doom-blue)';",
        'export const ToolCard = () => null;',
      ].join('\n'),
    );

    expect(result).toBeNull();
  });

  it('rejects a Tailwind arbitrary colour and names the token vocabulary', () => {
    const result = check(
      'src/web/features/session/ToolCard.tsx',
      "const card = 'rounded-md bg-[#312A1C] text-doom-yellow';\nexport const ToolCard = () => null;\n",
    );

    expect(result).toContain("hardcodes 'rounded-md bg-[#312A1C] text-doom-yellow'");
    expect(result).toContain('bg-doom-tint-yellow');
  });

  it('rejects a bare colour string in a style value', () => {
    const result = check(
      'web/RunCard.tsx',
      "export const RunCard = () => <div style={{ backgroundColor: '#282c34' }} />;\n",
    );

    expect(result).toContain("hardcodes '#282c34'");
  });

  it('rejects rgb and hsl functions', () => {
    expect(check('src/components/Dot.tsx', "const fill = 'rgb(255 108 107)';\n")).toContain("'rgb(255 108 107)'");
    expect(check('src/components/Dot.tsx', "const fill = 'hsla(0, 100%, 50%, 0.4)';\n")).toContain('hardcodes');
  });

  it('leaves the theme runtime, the theme configs and the tests alone', () => {
    expect(check('src/theme/builtinThemes.ts', "export const bg = '#282c34';\n")).toBeNull();
    expect(check('tests/theme/theme.test.ts', "expect(theme.tokens.bg).toBe('#282c34');\n")).toBeNull();
    expect(check('src/components/Dot.test.tsx', "const fill = '#282c34';\n")).toBeNull();
  });

  it('ignores server code and unreadable files', () => {
    expect(check('src/adapters/httpServer.ts', "const brand = '#282c34';\n")).toBeNull();
    expect(noRawThemeColor.check?.(path.join(root, 'src/web/missing.tsx'), root)).toBeNull();
  });
});
