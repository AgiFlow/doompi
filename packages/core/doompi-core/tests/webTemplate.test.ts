import { describe, expect, it } from 'vitest';

import { defineWebTemplate } from '../src/extensions/webPlugin';
import { parseWebTemplate } from '../src/web/schemas/template';

const template = {
  id: 'example-layout',
  label: 'Example',
  description: 'An independently packaged layout.',
  contractVersion: 1 as const,
  layout: () => null,
};

describe('web templates', () => {
  it('preserves a compatible contribution and accepts path-derived identity', () => {
    expect(parseWebTemplate(template)).toBe(template);
    const { id: _id, ...file } = template;
    expect(defineWebTemplate(file)).toBe(file);
  });

  it.each([
    null,
    {},
    { ...template, id: '../layout' },
    { ...template, id: 'x'.repeat(161) },
    { ...template, label: ' ' },
    { ...template, contractVersion: 2 },
    { ...template, layout: 'div' },
    { ...template, layout: {} },
  ])('refuses malformed or incompatible metadata without throwing: %j', (value) => {
    expect(parseWebTemplate(value)).toBeUndefined();
  });

  it('accepts React memo and forwardRef component wrappers', () => {
    for (const kind of ['react.memo', 'react.forward_ref']) {
      expect(parseWebTemplate({ ...template, layout: { $$typeof: Symbol.for(kind) } })).toBeDefined();
    }
  });
});
