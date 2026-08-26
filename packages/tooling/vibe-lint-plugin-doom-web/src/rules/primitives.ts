import type { RuleDefinition } from '@agimon-ai/vibe-lint';
import ts from 'typescript';
import { isComponentLibrary } from './componentLibrary.js';
import { projectPath, readSource } from './moduleGraph.js';

/** The interactive elements the shared library already owns, and what to reach for instead. */
const OWNED_ELEMENTS: Readonly<Record<string, string>> = {
  button: 'Button',
  input: 'Input',
  textarea: 'Textarea',
  select: 'Select',
};

/** A row of a listbox is an option, and OptionRow is the primitive for it. */
const OPTION_HINT = 'OptionRow';

const IGNORE_MARKER = /prefer-shared-primitive:\s*ignore/;

/** Browser source: the cockpit's client tree or a plugin's web/ tree. */
function isBrowserSource(relativePath: string): boolean {
  return relativePath.startsWith('src/web/') || relativePath.startsWith('web/');
}

function isTest(relativePath: string): boolean {
  return relativePath.startsWith('tests/') || relativePath.includes('.test.') || relativePath.includes('.spec.');
}

function tagNameOf(node: ts.JsxOpeningLikeElement): string | undefined {
  const name = node.tagName;
  return ts.isIdentifier(name) ? name.text : undefined;
}

function hasAttribute(node: ts.JsxOpeningLikeElement, attribute: string): boolean {
  return node.attributes.properties.some(
    (property) => ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === attribute,
  );
}

/**
 * Radix lends a primitive's behaviour to whatever element it wraps, so the
 * element under an `asChild` parent is that primitive's rendering, not a
 * bypass of it.
 */
function underAsChild(node: ts.JsxOpeningLikeElement): boolean {
  // An opening tag's parent is its own JsxElement; step past it so the search
  // starts at the element that encloses this one.
  const start = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent;
  for (let parent: ts.Node | undefined = start; parent !== undefined; parent = parent.parent) {
    if (ts.isJsxElement(parent)) return hasAttribute(parent.openingElement, 'asChild');
    // Only the immediately enclosing element lends its slot; a fragment or an
    // expression container between the two is transparent, anything else is not.
    if (!ts.isJsxFragment(parent) && !ts.isJsxExpression(parent)) return false;
  }
  return false;
}

export const preferSharedPrimitive: RuleDefinition = {
  preflight: true,
  rule: 'Browser code reaches for the shared primitive rather than restyling a raw element',
  rationale:
    'The component library exists so a button looks and behaves the same everywhere: one focus ring, one disabled state, one set of tokens. A raw <button className="…"> renders something that only resembles a Button, and the resemblance decays. It is also invisible in review, which is how the same chip came to be spelled ten different ways across the packages. Radix asChild is the escape hatch when a primitive must lend its styling to another element, and the rule stands down there.',
  check(filePath, configRoot) {
    const relativePath = projectPath(filePath, configRoot);
    if (relativePath === null || !isBrowserSource(relativePath) || isTest(relativePath)) return null;
    // The library is where the primitives are built, so it owns the raw elements.
    if (isComponentLibrary(configRoot)) return null;
    const sourceFile = readSource(filePath);
    if (!sourceFile) return null;
    if (IGNORE_MARKER.test(sourceFile.getFullText())) return null;

    const offenders = new Map<string, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = tagNameOf(node);
        const replacement = tag === undefined ? undefined : OWNED_ELEMENTS[tag];
        if (tag !== undefined && replacement !== undefined && !underAsChild(node)) {
          offenders.set(tag, replacement);
        }
        // A hand-rolled listbox row: it claims the role without the shape.
        if (
          tag !== undefined &&
          !OWNED_ELEMENTS[tag] &&
          node.attributes.properties.some(
            (property) =>
              ts.isJsxAttribute(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === 'role' &&
              property.initializer !== undefined &&
              ts.isStringLiteral(property.initializer) &&
              property.initializer.text === 'option',
          )
        ) {
          offenders.set(`${tag} role="option"`, OPTION_HINT);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (offenders.size === 0) return null;

    const listed = [...offenders].map(([tag, replacement]) => `<${tag}> (use ${replacement})`).join(', ');
    return `${relativePath} renders ${listed} directly. Import the primitive from @agimon-ai/doompi-web-components instead, or wrap the element in the primitive with asChild when it must stay this element. A row that genuinely has no primitive can opt out with a "prefer-shared-primitive: ignore" comment naming why.`;
  },
};
