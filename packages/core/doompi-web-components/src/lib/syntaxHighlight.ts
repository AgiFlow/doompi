import type { CSSProperties } from 'react';
import { DOOM_SYNTAX_STYLES } from './editorTheme.ts';
import { type GrammarKey, grammarKeyOf, loadGrammar } from './editorLanguage.ts';

/**
 * Static syntax highlighting for read-only code, the timeline's half of the
 * editor's `syntaxHighlighting`.
 *
 * A tool card shows code it cannot edit, so it needs the colours without the
 * editor: the same grammars `editorLanguage.ts` loads and the same token
 * palette `editorTheme.ts` names, run once over a string and handed back as
 * spans. Everything CodeMirror-shaped is behind a dynamic import, so a session
 * that never opens a code result never downloads a parser, and the caller
 * always has plain text to show first.
 */

/** The palette keys a token can land on; the styles themselves are the editor's. */
export type SyntaxToken = keyof typeof DOOM_SYNTAX_STYLES;

/** One run of same-styled text inside a line. `token` absent means unstyled. */
export interface SyntaxSpan {
  text: string;
  token?: SyntaxToken;
}

/** Lines of spans, one array per source line, so a gutter can pair with them. */
export type SyntaxLines = readonly (readonly SyntaxSpan[])[];

/**
 * Above this the parse costs more than the colour is worth. Tool results are
 * bounded well below it; a pasted file is not, and blocking the frame to paint
 * a wall of text nobody reads is the worse outcome.
 */
const MAX_HIGHLIGHT_CHARS = 200_000;

/** Only the first line is needed to spot a shebang, and reading more of a big string is waste. */
const SNIFF_CHARS = 200;

const SHEBANG_GRAMMARS: ReadonlyArray<{ readonly pattern: RegExp; readonly grammar: GrammarKey }> = [
  { pattern: /^#!.*\b(?:bash|sh|zsh|dash|ksh)\b/, grammar: 'shell' },
  { pattern: /^#!.*\bpython[\d.]*\b/, grammar: 'python' },
  { pattern: /^#!.*\b(?:node|bun|deno)\b/, grammar: 'javascript' },
];

/** JSON is the one shape worth guessing from the body: a document is an object or an array. */
const JSON_SHAPE = /^\s*[[{][\s\S]*[\]}]\s*$/;

export interface GrammarQuery {
  /** The file the text came from, when the tool knows one. */
  path?: string | undefined;
  /** The text itself, used only when the path settles nothing. */
  text?: string | undefined;
}

/**
 * Which grammar to colour a result with.
 *
 * The path decides whenever it can, because a name is evidence and a body is a
 * guess. Sniffing only answers for text that arrived without a usable name: a
 * shebang says what runs the script, and a document that opens and closes with
 * brackets is treated as JSON. Anything else stays plain rather than being
 * coloured as the wrong language.
 */
export function detectGrammar(query: GrammarQuery): GrammarKey | undefined {
  const byPath = query.path === undefined || query.path.length === 0 ? undefined : grammarKeyOf(query.path);
  if (byPath !== undefined) return byPath;
  const text = query.text ?? '';
  if (text.length === 0) return undefined;
  const head = text.slice(0, SNIFF_CHARS);
  if (head.startsWith('#!')) {
    const firstLine = head.split('\n', 1)[0] ?? '';
    for (const entry of SHEBANG_GRAMMARS) {
      if (entry.pattern.test(firstLine)) return entry.grammar;
    }
    // A shebang naming something with no grammar here is still a script.
    return 'shell';
  }
  return JSON_SHAPE.test(text) ? 'json' : undefined;
}

/** The inline style a token wears. Colours come from the editor palette, which names theme tokens. */
export function syntaxStyleOf(token: SyntaxToken | undefined): CSSProperties | undefined {
  return token === undefined ? undefined : DOOM_SYNTAX_STYLES[token];
}

/**
 * Every tag the palette answers for, in the order the editor lists them. The
 * class each entry carries is a palette key rather than a CSS class: the
 * result is rendered as inline styles, so nothing has to be mounted in the
 * document for a card to show colour.
 */
async function doomHighlighter() {
  const { tagHighlighter, tags } = await import('@lezer/highlight');
  return tagHighlighter([
    { tag: tags.comment, class: 'comment' satisfies SyntaxToken },
    { tag: tags.keyword, class: 'keyword' satisfies SyntaxToken },
    { tag: [tags.atom, tags.bool, tags.null, tags.self], class: 'constant' satisfies SyntaxToken },
    { tag: tags.number, class: 'literal' satisfies SyntaxToken },
    { tag: [tags.string, tags.special(tags.string)], class: 'string' satisfies SyntaxToken },
    { tag: tags.regexp, class: 'regexp' satisfies SyntaxToken },
    { tag: [tags.operator, tags.operatorKeyword], class: 'operator' satisfies SyntaxToken },
    { tag: [tags.punctuation, tags.separator, tags.bracket], class: 'punctuation' satisfies SyntaxToken },
    { tag: [tags.variableName, tags.definition(tags.variableName)], class: 'variable' satisfies SyntaxToken },
    { tag: [tags.propertyName, tags.definition(tags.propertyName)], class: 'property' satisfies SyntaxToken },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      class: 'callable' satisfies SyntaxToken,
    },
    { tag: [tags.typeName, tags.className, tags.namespace], class: 'type' satisfies SyntaxToken },
    { tag: [tags.tagName, tags.angleBracket], class: 'tag' satisfies SyntaxToken },
    { tag: tags.attributeName, class: 'attribute' satisfies SyntaxToken },
    { tag: [tags.meta, tags.processingInstruction, tags.documentMeta], class: 'meta' satisfies SyntaxToken },
    { tag: tags.heading, class: 'heading' satisfies SyntaxToken },
    { tag: [tags.link, tags.url], class: 'link' satisfies SyntaxToken },
    { tag: tags.emphasis, class: 'emphasis' satisfies SyntaxToken },
    { tag: tags.strong, class: 'strong' satisfies SyntaxToken },
    { tag: tags.strikethrough, class: 'strikethrough' satisfies SyntaxToken },
    { tag: tags.invalid, class: 'invalid' satisfies SyntaxToken },
  ]);
}

/** The parser behind a grammar. `loadGrammar` hands back an editor extension, which wraps one. */
async function parserFor(grammar: GrammarKey) {
  const [{ Language, LanguageSupport }, extension] = await Promise.all([
    import('@codemirror/language'),
    loadGrammar(grammar),
  ]);
  if (extension instanceof LanguageSupport) return extension.language.parser;
  if (extension instanceof Language) return extension.parser;
  return undefined;
}

/**
 * Colours `text` as `grammar`, as lines of spans.
 *
 * The whole text is parsed at once even though the caller may render it line
 * by line, because a template literal or a block comment only makes sense with
 * its neighbours. Text past the size cap, and a grammar whose extension turns
 * out to carry no parser, come back unhighlighted rather than throwing: colour
 * is decoration, and the caller already has the plain text on screen.
 */
export async function highlightToLines(text: string, grammar: GrammarKey): Promise<SyntaxLines | undefined> {
  if (text.length === 0 || text.length > MAX_HIGHLIGHT_CHARS) return undefined;
  const [{ highlightCode }, highlighter, parser] = await Promise.all([
    import('@lezer/highlight'),
    doomHighlighter(),
    parserFor(grammar),
  ]);
  if (parser === undefined) return undefined;

  const lines: SyntaxSpan[][] = [[]];
  highlightCode(
    text,
    parser.parse(text),
    highlighter,
    (code, classes) => {
      const current = lines[lines.length - 1];
      // `classes` is the palette key this module handed the tag highlighter,
      // or empty for text no tag claimed.
      current?.push(classes === '' ? { text: code } : { text: code, token: classes as SyntaxToken });
    },
    () => lines.push([]),
  );
  return lines;
}
