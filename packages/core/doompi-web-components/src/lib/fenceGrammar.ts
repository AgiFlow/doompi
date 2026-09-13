import { type GrammarKey, grammarKeyOf } from './editorLanguage';

/**
 * What a fenced code block's info string means.
 *
 * A fence names its language the way a person writes it in a message, so
 * `ts`, `typescript` and `tsx` all arrive and all mean something. The file
 * lookup in `editorLanguage.ts` already answers for every spelling that is
 * also an extension, so this module only carries the words that are not one
 * and leaves the rest to it. A name with no grammar is not an error: the block
 * renders as plain text, which is what it would have done anyway.
 */

/** The one fence that is a picture rather than code. */
export const MERMAID_LANGUAGE = 'mermaid';

/** Spellings a fence uses that no filename would. */
const GRAMMAR_BY_WORD: Readonly<Record<string, GrammarKey>> = {
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
  shell: 'shell',
  console: 'shell',
  docker: 'dockerfile',
};

/**
 * The language a fence declares, lower-cased, or undefined for a bare fence.
 *
 * react-markdown hands the info string down as a `language-*` class, and a
 * fence may carry metadata after the language (```` ```ts title=x ````), which
 * is not part of the name.
 */
export function fenceLanguageOf(className: string | undefined): string | undefined {
  const match = /(?:^|\s)language-(\S+)/.exec(className ?? '');
  return match?.[1]?.toLowerCase();
}

/** The grammar to colour a fence with, or undefined to leave it plain. */
export function fenceGrammarOf(language: string | undefined): GrammarKey | undefined {
  if (language === undefined || language.length === 0) return undefined;
  const word = GRAMMAR_BY_WORD[language];
  if (word !== undefined) return word;
  // A fence that names an extension is the same lookup a file gets, and one
  // that names a whole file, like `dockerfile`, is tried as that name first.
  return grammarKeyOf(language) ?? grammarKeyOf(`fence.${language}`);
}
