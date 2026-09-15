import { describe, expect, it } from 'vitest';

import { canonicalJson, canonicalValue } from '../../../src/services/canonical';

describe('canonical prompt cache identity values', () => {
  it('normalizes equivalent text, object ordering, negative zero, and omitted values', () => {
    const decomposed = {
      z: -0,
      ignored: undefined,
      'cafe\u0301': 're\u0301sume\u0301',
    };
    const composed = {
      'caf\u00e9': 'r\u00e9sum\u00e9',
      z: 0,
    };

    expect(canonicalValue(decomposed)).toEqual(composed);
    expect(canonicalJson(decomposed)).toBe(canonicalJson(composed));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite identity number %s',
    (value) => {
      expect(() => canonicalValue(value)).toThrow('Prompt cache identity cannot contain a non-finite number.');
    },
  );

  it('rejects unsupported identity values', () => {
    expect(() => canonicalValue(Symbol('unsupported'))).toThrow('Unsupported prompt cache identity value: symbol.');
  });
});
