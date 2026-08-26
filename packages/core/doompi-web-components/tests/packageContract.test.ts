import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  name: string;
  exports: Record<string, unknown>;
  files: string[];
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};
const project = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8')) as { sourceTemplate: string };

describe('package contract', () => {
  it('exposes one subpath per export module plus the stylesheet and themes', () => {
    const modules = fs
      .readdirSync(path.join(root, 'src', 'exports'))
      .map((file) => (file === 'index.ts' ? '.' : `./${file.replace(/\.ts$/, '')}`))
      .sort();
    const subpaths = Object.keys(manifest.exports)
      .filter((key) => key !== './package.json' && key !== './styles.css' && key !== './themes/*.json')
      .sort();
    expect(subpaths).toEqual(modules);
    expect(manifest.exports['./styles.css']).toBe('./styles/tokens.css');
    expect(fs.existsSync(path.join(root, 'styles', 'tokens.css'))).toBe(true);
  });

  it('ships the stylesheet and themes, keeps React a peer, and names its template', () => {
    expect(manifest.name).toBe('@agimon-ai/doompi-web-components');
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'styles', 'themes', 'llms.txt']));
    expect(Object.keys(manifest.peerDependencies)).toEqual(['react', 'react-dom']);
    expect(manifest.dependencies.react).toBeUndefined();
    expect(project.sourceTemplate).toBe('web-components');
  });

  it('publishes every JSON theme the registry loads', () => {
    const files = fs.readdirSync(path.join(root, 'themes')).filter((file) => file.endsWith('.json'));
    expect(files.sort()).toEqual(['doom-nord-dark.json', 'doom-one-dark.json', 'doom-one-light.json']);
  });

  it('keeps the stylesheet defaults equal to the shipped dark theme', () => {
    const css = fs.readFileSync(path.join(root, 'styles', 'tokens.css'), 'utf8');
    const dark = JSON.parse(fs.readFileSync(path.join(root, 'themes', 'doom-one-dark.json'), 'utf8')) as {
      tokens: Record<string, string>;
    };
    for (const [token, value] of Object.entries(dark.tokens)) {
      expect(css, token).toContain(`--doom-${token}: ${value};`);
    }
  });
});
