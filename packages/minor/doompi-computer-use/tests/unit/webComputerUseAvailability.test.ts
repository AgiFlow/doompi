import { describe, expect, it } from 'vitest';
import {
  computerUseSessionApiError,
  MissingComputerUseApiError,
  missingComputerUseApiRetryAt,
} from '../../src/adapters/webComputerUseAvailability.ts';

describe('computer-use web hub availability', () => {
  it('classifies an absent opt-in session API for dormant retry', () => {
    const error = computerUseSessionApiError(404, { error: "No API 'computer-use' in this session." });

    expect(error).toBeInstanceOf(MissingComputerUseApiError);
    expect(missingComputerUseApiRetryAt(1_000)).toBe(6_000);
  });

  it('preserves genuine session API failures', () => {
    expect(computerUseSessionApiError(500, { error: 'broken session socket' })).toEqual(
      new Error('broken session socket'),
    );
    expect(computerUseSessionApiError(503, undefined)).toEqual(new Error('HTTP 503'));
  });
});
