import { describe, expect, it } from 'vitest';
import { type GrammarKey, loadGrammar } from '../../src/lib/editorLanguage.ts';

/**
 * Every key resolves to a real grammar.
 *
 * This is the half of the language lookup that a type checker cannot vouch
 * for: each arm names a package subpath and an export inside it, and both are
 * strings until something imports them. The legacy stream modes are the sharp
 * edge, since their exports are not named after their files (`dockerFile`, not
 * `dockerfile`), and a wrong name there fails at the moment a reader opens the
 * file rather than at build.
 */
const KEYS: readonly GrammarKey[] = [
  'javascript',
  'jsx',
  'typescript',
  'tsx',
  'json',
  'markdown',
  'html',
  'css',
  'python',
  'yaml',
  'shell',
  'toml',
  'dockerfile',
];

describe('loadGrammar', () => {
  it.each(KEYS)('loads the %s grammar', async (key) => {
    await expect(loadGrammar(key)).resolves.toBeDefined();
  });
});
