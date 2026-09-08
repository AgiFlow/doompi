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

/**
 * A Tailwind arbitrary value on one of the four scales the theme owns:
 * `text-[11px]`, `rounded-[3px]`, `tracking-[0.14em]`, `leading-[17px]`, and
 * the side-specific radius forms such as `rounded-tl-[3px]`.
 */
const ARBITRARY_SCALE = /(?<![\w-])(text|rounded|tracking|leading)(?:-(?:[trbl]{1,2}|[a-z]+))?-\[([^\]]+)\]/g;

/**
 * `rounded-[inherit]` is not a size, it is a child agreeing to whatever radius
 * its clipping parent already chose, and no token can express that.
 */
const ALLOWED_ARBITRARY = new Set(['inherit']);

/** The token each scale expects, quoted back at whoever tripped the rule. */
const SCALE_TOKENS: Record<string, string> = {
  text: 'text-2xs (9px), text-xs (10px), text-sm (12px), text-base (13px), text-lg (15px)',
  rounded: 'rounded-xs (2px), rounded-sm (3px), rounded-md (5px), rounded-lg (10px), rounded-full',
  tracking: 'tracking-wide (0.08em), tracking-wider (0.14em), tracking-widest (0.18em)',
  leading: 'leading-none, leading-tight, leading-snug, leading-normal, leading-relaxed',
};

export const noArbitraryStyleValue: RuleDefinition = {
  preflight: true,
  rule: 'Browser code sizes type, radius, tracking and leading from the scale, never an arbitrary value',
  rationale:
    'A scale is only a scale if nothing steps outside it. One `text-[11px]` looks harmless, but it is a rung nobody else can land on: the next component copies it, and soon the same visual weight exists at 10px, 11px and 12px with no way to tell which was deliberate. Arbitrary values also survive a token change silently, so retuning the ramp moves every honest call site and leaves the opt-outs behind, drifting further each time. Naming a rung states the intent, and a reviewer can see that two things match without measuring them.',
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    if (relativePath === null || declaresColors(relativePath) || !isBrowserSource(relativePath)) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;

    const offenders = new Set<string>();
    const scales = new Set<string>();
    const visit = (node: ts.Node): void => {
      // Template spans matter: many className values are built with `${}`.
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        for (const match of node.text.matchAll(ARBITRARY_SCALE)) {
          const [utility, scale, value] = [match[0], match[1] ?? '', match[2] ?? ''];
          // A colour written into a text utility is the other rule's business.
          if (ALLOWED_ARBITRARY.has(value) || BARE_COLOR.test(value)) continue;
          offenders.add(utility.slice(0, 60));
          scales.add(scale);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (offenders.size === 0) return null;

    const expected = [...scales].map((scale) => `${scale}: ${SCALE_TOKENS[scale]}`).join('; ');
    return `${relativePath} hardcodes ${[...offenders].map((value) => `'${value}'`).join(', ')}. Browser code names a rung on the scale instead (${expected}). If the ramp has no rung for what you mean, add one to styles/tokens.css so every caller can reach it, rather than spelling the value here.`;
  },
};
