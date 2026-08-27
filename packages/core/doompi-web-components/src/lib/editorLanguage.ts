import type { StreamParser } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

/**
 * Which grammar a file gets, and how it arrives.
 *
 * The two halves are apart on purpose. Naming the grammar is a pure lookup a
 * caller can run before deciding anything, and loading it is a dynamic import
 * so a session that only ever opens Markdown never downloads the JavaScript
 * parser. Nothing here imports CodeMirror at runtime: every specifier below is
 * either a type, which erases, or inside an `import()` the bundler splits into
 * its own chunk.
 */

export type GrammarKey =
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'json'
  | 'markdown'
  | 'html'
  | 'css'
  | 'python'
  | 'yaml'
  | 'shell'
  | 'toml'
  | 'dockerfile';

/** Keyed by lower-case extension without the dot. */
const GRAMMAR_BY_EXTENSION: Readonly<Record<string, GrammarKey>> = {
  cjs: 'javascript',
  js: 'javascript',
  mjs: 'javascript',
  jsx: 'jsx',
  cts: 'typescript',
  mts: 'typescript',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  markdown: 'markdown',
  md: 'markdown',
  htm: 'html',
  html: 'html',
  xhtml: 'html',
  css: 'css',
  py: 'python',
  pyi: 'python',
  yaml: 'yaml',
  yml: 'yaml',
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
  toml: 'toml',
};

/** Files a project names rather than suffixes, matched on the whole lower-cased basename. */
const GRAMMAR_BY_FILENAME: Readonly<Record<string, GrammarKey>> = {
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  containerfile: 'dockerfile',
  dockerfile: 'dockerfile',
};

/** The last segment of a path, lower-cased. */
function basenameOf(filePath: string): string {
  return (filePath.split('/').at(-1) ?? '').toLowerCase();
}

/**
 * The grammar for a path, or undefined for a file the editor shows as plain
 * text. A name is tried whole before it is tried as a suffix, so
 * `Dockerfile.dev` is a Dockerfile and not a file with a `dev` extension.
 */
export function grammarKeyOf(filePath: string): GrammarKey | undefined {
  const name = basenameOf(filePath);
  const named = GRAMMAR_BY_FILENAME[name];
  if (named !== undefined) return named;
  const dot = name.lastIndexOf('.');
  if (dot < 1) return undefined;
  return GRAMMAR_BY_EXTENSION[name.slice(dot + 1)];
}

/** A legacy stream mode wrapped as a language; the modes predate Lezer and ship as tokenizers. */
async function streamMode(load: () => Promise<StreamParser<unknown>>): Promise<Extension> {
  const [{ StreamLanguage }, parser] = await Promise.all([import('@codemirror/language'), load()]);
  return StreamLanguage.define(parser);
}

/** Downloads one grammar. Each arm is its own chunk, so the cost is the languages actually opened. */
export async function loadGrammar(key: GrammarKey): Promise<Extension> {
  switch (key) {
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript();
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'html':
      return (await import('@codemirror/lang-html')).html();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'shell':
      return streamMode(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell);
    case 'toml':
      return streamMode(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml);
    case 'dockerfile':
      return streamMode(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
  }
}
