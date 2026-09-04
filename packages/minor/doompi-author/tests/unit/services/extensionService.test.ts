import { describe, expect, it } from 'vitest';
import { DefaultAuthorExtensionService } from '../../../src/services/extensionService.ts';

describe('DefaultAuthorExtensionService', () => {
  it('returns the command result without depending on a host API', async () => {
    const service = new DefaultAuthorExtensionService();

    await expect(service.execute()).resolves.toEqual({
      message: 'Open the Author visual steering workspace',
      level: 'info',
    });
  });
});
