import { describe, expect, it } from 'vitest';
import { grammarKeyOf } from '../../src/lib/editorLanguage.ts';

describe('grammarKeyOf', () => {
  it('tells the four JavaScript dialects apart, because they parse differently', () => {
    expect(grammarKeyOf('app.js')).toBe('javascript');
    expect(grammarKeyOf('app.jsx')).toBe('jsx');
    expect(grammarKeyOf('app.ts')).toBe('typescript');
    expect(grammarKeyOf('app.tsx')).toBe('tsx');
  });

  it('folds the module variants onto the dialect they are', () => {
    expect(grammarKeyOf('config.mjs')).toBe('javascript');
    expect(grammarKeyOf('config.cjs')).toBe('javascript');
    expect(grammarKeyOf('config.mts')).toBe('typescript');
  });

  it('names the grammar for the rest of the set', () => {
    expect(grammarKeyOf('package.json')).toBe('json');
    expect(grammarKeyOf('README.md')).toBe('markdown');
    expect(grammarKeyOf('index.html')).toBe('html');
    expect(grammarKeyOf('app.css')).toBe('css');
    expect(grammarKeyOf('train.py')).toBe('python');
    expect(grammarKeyOf('ci.yml')).toBe('yaml');
    expect(grammarKeyOf('Cargo.toml')).toBe('toml');
  });

  it('covers shell, which is how the agent edits files it has no tool for', () => {
    expect(grammarKeyOf('fix.sh')).toBe('shell');
    expect(grammarKeyOf('setup.bash')).toBe('shell');
    expect(grammarKeyOf('.zshrc')).toBe('shell');
  });

  it('matches a whole filename before it tries a suffix', () => {
    expect(grammarKeyOf('Dockerfile')).toBe('dockerfile');
    expect(grammarKeyOf('build/Containerfile')).toBe('dockerfile');
    // Not a file with a `dev` extension.
    expect(grammarKeyOf('Dockerfile.dev')).toBeUndefined();
  });

  it('reads the extension whatever case it is written in, and only in the last segment', () => {
    expect(grammarKeyOf('App.TSX')).toBe('tsx');
    expect(grammarKeyOf('src/py/notes.md')).toBe('markdown');
  });

  it('answers undefined for a file it has no grammar for, which the editor shows as plain text', () => {
    expect(grammarKeyOf('notes.txt')).toBeUndefined();
    expect(grammarKeyOf('LICENSE')).toBeUndefined();
    expect(grammarKeyOf('.env')).toBeUndefined();
    expect(grammarKeyOf('')).toBeUndefined();
  });
});
