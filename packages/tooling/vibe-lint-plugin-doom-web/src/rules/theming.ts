import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
import { projectPath, readSource } from './moduleGraph.js';

/** A Tailwind arbitrary colour: the `bg-[#312A1C]` shape, in any utility. */
const ARBITRARY_COLOR = /-\[#[0-9a-f]{3,8}\]/i;
/** A string that is nothing but a colour: '#282c34', 'rgb(1 2 3)', 'hsl(...)'. */
const BARE_COLOR = /^\s*(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([^)]*\))\s*$/i;

/**
 * Where colours are the subject rather than a choice: the theme configs
 * themselves, the modules that parse and derive them, and the tests that
 * assert on them.
 */
function declaresColors(relativePath: string): boolean {
  return (
    relativePath.startsWith('src/theme/') ||
    relativePath.startsWith('themes/') ||
    relativePath.startsWith('tests/') ||
    relativePath.includes('.test.') ||
    relativePath.includes('.spec.')
  );
}

/** Browser source: the cockpit's client tree, a plugin's src/web tree, or a component library's src. */
function isBrowserSource(relativePath: string): boolean {
  if (relativePath.startsWith('src/web/')) return true;
  return relativePath.startsWith('src/components/') || relativePath.startsWith('src/lib/');
}

export const noRawThemeColor: RuleDefinition = {
  preflight: true,
  rule: 'Browser code names a theme token, never a colour literal',
  rationale:
    'A theme is only a theme if every colour on the page comes from it. One literal hex is invisible in review and then permanent: it survives a theme switch, so a dark-tuned tint sits inside a light surface and the reader assumes the theme is broken rather than that one card opted out. Naming a token also names the intent, and a reviewer can tell a warning tint from a brand blue without opening a colour picker.',
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    if (relativePath === null || declaresColors(relativePath) || !isBrowserSource(relativePath)) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;

    const offenders = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        const text = node.text;
        if (ARBITRARY_COLOR.test(text) || BARE_COLOR.test(text)) offenders.add(text.trim().slice(0, 60));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (offenders.size === 0) return null;

    return `${relativePath} hardcodes ${[...offenders].map((value) => `'${value}'`).join(', ')}. Browser code names a theme token instead: a Tailwind class such as bg-doom-panel, text-doom-hi, border-doom-edge-red, or bg-doom-tint-yellow, or the CSS custom property var(--doom-blue). If the palette has no token for what you mean, add one to the theme contract rather than spelling the colour here.`;
  },
};
