import { describe, expect, it } from 'vitest';
import { BUNDLE_UPDATED_MESSAGE, parseBundleUpdatedMessage } from '../../src/types/bundle.ts';

describe('the verifier-to-page bundle message', () => {
  it('reads a committed revision', () => {
    expect(parseBundleUpdatedMessage({ type: BUNDLE_UPDATED_MESSAGE, revision: 7 })).toEqual({
      type: BUNDLE_UPDATED_MESSAGE,
      revision: 7,
    });
  });

  it.each([
    ['a plugin channel frame', { type: 'doompi:something-else', revision: 7 }],
    ['a missing revision', { type: BUNDLE_UPDATED_MESSAGE }],
    ['a revision below the first signing', { type: BUNDLE_UPDATED_MESSAGE, revision: 0 }],
    ['a fractional revision', { type: BUNDLE_UPDATED_MESSAGE, revision: 1.5 }],
    ['a revision that is not a number', { type: BUNDLE_UPDATED_MESSAGE, revision: '7' }],
    ['an array', ['doompi:bundle-updated', 7]],
    ['null', null],
    ['a bare string', 'doompi:bundle-updated'],
  ])('ignores %s, because one channel carries every worker message', (_label, value) => {
    expect(parseBundleUpdatedMessage(value)).toBeUndefined();
  });
});
