import { describe, expect, it } from 'vitest';

import standardPiExtension, { extension as activatePlanExtension } from '../generated/pi';

describe('Doom Plan Pi entry', () => {
  it('exports its named declaration as the loader default', () => {
    expect(standardPiExtension).toBe(activatePlanExtension);
    expect(typeof standardPiExtension.install).toBe('function');
  });
});
