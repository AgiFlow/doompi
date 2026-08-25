import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preferSharedPrimitive } from '../../src/rules/primitives.js';

describe('Prefer shared primitive rule', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-primitives-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function check(relativePath: string, source: string): string | null | undefined {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source, 'utf8');
    return preferSharedPrimitive.check?.(filePath, root);
  }

  it('names the primitive a restyled element should have been', () => {
    const result = check(
      'src/web/features/session/Composer.tsx',
      'export const Composer = () => <button className="rounded bg-doom-panel">send</button>;',
    );

    expect(result).toContain('<button> (use Button)');
    expect(result).toContain('@agimon-ai/doompi-web-components');
  });

  it('covers a plugin web/ tree as well as the cockpit client', () => {
    expect(check('web/RunsPanel.tsx', 'export const P = () => <input className="px-2" />;')).toContain(
      '<input> (use Input)',
    );
  });

  it('lists each offending element once, however many times it appears', () => {
    const result = check(
      'web/Panel.tsx',
      [
        'export const P = () => (',
        '  <div>',
        '    <button />',
        '    <button />',
        '    <textarea />',
        '  </div>',
        ');',
      ].join('\n'),
    );

    expect(result).toContain('<button> (use Button)');
    expect(result).toContain('<textarea> (use Textarea)');
    expect(result?.match(/<button>/g)).toHaveLength(1);
  });

  it('stands down under asChild, which is how a primitive lends its styling', () => {
    const result = check(
      'web/RunsPanel.tsx',
      [
        'export const P = () => (',
        '  <Badge asChild>',
        '    <button onClick={run}>go</button>',
        '  </Badge>',
        ');',
      ].join('\n'),
    );

    expect(result).toBeNull();
  });

  it('still reports an element that only has an asChild grandparent', () => {
    const result = check(
      'web/RunsPanel.tsx',
      [
        'export const P = () => (',
        '  <Badge asChild>',
        '    <div>',
        '      <button>go</button>',
        '    </div>',
        '  </Badge>',
        ');',
      ].join('\n'),
    );

    expect(result).toContain('<button> (use Button)');
  });

  it('names OptionRow for a hand-rolled listbox row', () => {
    expect(check('web/List.tsx', 'export const P = () => <div role="option">a</div>;')).toContain(
      '<div role="option"> (use OptionRow)',
    );
  });

  it('leaves the component library alone, since that is where the primitives are built', () => {
    fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
    expect(check('src/components/Button.tsx', 'export const B = () => <button />;')).toBeNull();
  });

  it('ignores tests and code outside a browser tree', () => {
    expect(check('tests/web/Composer.test.tsx', 'export const P = () => <button />;')).toBeNull();
    expect(check('src/services/render.tsx', 'export const P = () => <button />;')).toBeNull();
  });

  it('honours an opt-out that says why', () => {
    const result = check(
      'web/Chart.tsx',
      [
        '// prefer-shared-primitive: ignore — the legend toggle is an SVG hit area, not a button.',
        'export const P = () => <button />;',
      ].join('\n'),
    );

    expect(result).toBeNull();
  });
});
