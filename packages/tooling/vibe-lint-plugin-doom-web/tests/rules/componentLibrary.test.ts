import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doomComponentsLayerBoundary, isComponentLibrary } from '../../src/rules/componentLibrary.js';

describe('Doom components layer boundary rule', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-components-'));
    // The shape that marks a component library: components, and no src/web.
    fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
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

  function check(relativePath: string, source: string): string | null | undefined {
    return doomComponentsLayerBoundary.check?.(write(relativePath, source), root);
  }

  it('recognises a component library by its shape', () => {
    expect(isComponentLibrary(root)).toBe(true);
    const webApp = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-web-app-'));
    fs.mkdirSync(path.join(webApp, 'src', 'web'), { recursive: true });
    fs.mkdirSync(path.join(webApp, 'src', 'components'), { recursive: true });
    expect(isComponentLibrary(webApp)).toBe(false);
    fs.rmSync(webApp, { recursive: true, force: true });
  });

  it('accepts a component reaching icons, lib and types', () => {
    const result = check(
      'src/components/Button.tsx',
      [
        "import { CheckIcon } from '../icons/icons';",
        "import { cn } from '../lib/cn';",
        "import type { ThemeToken } from '../types/theme';",
        "import { Badge } from './Badge';",
        "import { cva } from 'class-variance-authority';",
        'export const Button = () => null;',
      ].join('\n'),
    );

    expect(result).toBeNull();
  });

  it('rejects a component importing the theme runtime, and says why', () => {
    const result = check(
      'src/components/Button.tsx',
      "import { DEFAULT_THEME } from '../theme/builtinThemes';\nexport const Button = () => null;\n",
    );

    expect(result).toContain('src/components may not import src/theme');
    expect(result).toContain('CSS custom properties');
    expect(result).toContain('bg-doom-panel');
  });

  it('rejects the theme runtime reaching a component and lib reaching components', () => {
    expect(check('src/theme/apply.ts', "import { Button } from '../components/Button';\n")).toContain(
      'src/theme may not import src/components',
    );
    expect(check('src/lib/cn.ts', "import { Button } from '../components/Button';\n")).toContain(
      'src/lib may not import src/components',
    );
  });

  it('lets exports reach every layer', () => {
    const result = check(
      'src/exports/index.ts',
      [
        "export { Button } from '../components/Button';",
        "export { applyTheme } from '../theme/apply';",
        "export { cn } from '../lib/cn';",
      ].join('\n'),
    );

    expect(result).toBeNull();
  });

  it('ignores a web application and unreadable files', () => {
    const webApp = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-web-app-'));
    fs.mkdirSync(path.join(webApp, 'src', 'web'), { recursive: true });
    const filePath = path.join(webApp, 'src', 'services', 'thing.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "import { x } from '../adapters/y';\n", 'utf8');
    expect(doomComponentsLayerBoundary.check?.(filePath, webApp)).toBeNull();
    fs.rmSync(webApp, { recursive: true, force: true });

    expect(doomComponentsLayerBoundary.check?.(path.join(root, 'src/components/Missing.tsx'), root)).toBeNull();
  });
});
