import { describe, expect, it } from 'vitest';
import standardPiExtension, { activatePlanExtension } from '../src/extensions/pi';

describe('Doom Plan Pi entry', () => {
  it('exports its named declaration as the loader default', () => {
    expect(standardPiExtension).toBe(activatePlanExtension);
    expect(typeof standardPiExtension.install).toBe('function');
  });
});
