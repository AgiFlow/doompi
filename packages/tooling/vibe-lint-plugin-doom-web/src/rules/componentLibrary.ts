import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import { collectSpecifiers, projectPath, readSource } from './moduleGraph.js';

/**
 * What each layer of a shared web component library may import.
 *
 * Not a linear order, because one edge a linear order would allow is the one
 * that matters most: a component must not import the theme runtime. Colour
 * reaches a component through CSS custom properties, never through a value it
 * read, which is what lets a theme swap recolour a rendered tree without
 * re-rendering it and what keeps every component usable before a theme loads.
 */
const ALLOWED: Readonly<Record<string, readonly string[] | undefined>> = {
  types: ['types'],
  lib: ['lib', 'types'],
  icons: ['icons'],
  theme: ['theme', 'types'],
  components: ['components', 'icons', 'lib', 'types'],
  exports: ['components', 'exports', 'icons', 'lib', 'theme', 'types'],
};

const LAYER_SUMMARY =
  'types and lib are the base, icons and theme sit beside them, components build on components, icons and lib, and exports may reach everything';

/** A component library has no src/web: its whole tree is the browser bundle. */
export function isComponentLibrary(configRoot: string): boolean {
  return (
    !fs.existsSync(path.join(configRoot, 'src', 'web')) && fs.existsSync(path.join(configRoot, 'src', 'components'))
  );
}

/** The layer a path belongs to, or undefined when it is outside src. */
function layerOf(filePath: string, configRoot: string): string | undefined {
  const relativePath = projectPath(filePath, configRoot);
  if (relativePath === null) return undefined;
  const parts = relativePath.split('/');
  return parts[0] === 'src' && parts.length > 1 ? parts[1] : undefined;
}

export const doomComponentsLayerBoundary: RuleDefinition = {
  preflight: true,
  rule: 'A shared web component library points inward, and a component never imports the theme runtime',
  rationale:
    'A component library is imported by every surface that renders, so a wrong edge inside it is a wrong edge everywhere. The one worth naming is components reaching the theme: the moment a component reads a colour as a value it renders one theme, and swapping a theme means re-rendering the tree instead of rewriting a custom property. Keep colours in CSS variables and components stay theme-agnostic, testable without a theme, and cheap to restyle.',
  check(filePath, configRoot) {
    if (!isComponentLibrary(configRoot)) return null;
    const layer = layerOf(filePath, configRoot);
    const allowed = layer === undefined ? undefined : ALLOWED[layer];
    if (allowed === undefined) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;

    const messages = new Set<string>();
    for (const specifier of collectSpecifiers(sourceFile)) {
      if (!specifier.startsWith('.')) continue;
      const target = layerOf(path.resolve(path.dirname(filePath), specifier), configRoot);
      if (target === undefined || allowed.includes(target)) continue;
      messages.add(
        target === 'theme' && layer === 'components'
          ? `src/components may not import src/theme ('${specifier}'). A component takes its colours from the theme's CSS custom properties, so it renders correctly under any theme without reading one. Use a token class such as bg-doom-panel, or take the value as a prop.`
          : `src/${layer} may not import src/${target} ('${specifier}'). In a component library ${LAYER_SUMMARY}. Move the shared code down to a layer both sides may read.`,
      );
    }
    return messages.size > 0 ? [...messages].join(' ') : null;
  },
};
