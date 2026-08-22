import { describe, expect, it } from 'vitest';
import { DefaultGoalExtensionService } from '../../../src/services/extensionService.ts';

describe('DefaultGoalExtensionService', () => {
  it('returns the command result without depending on a host API', async () => {
    const service = new DefaultGoalExtensionService();

    await expect(service.execute()).resolves.toEqual({ message: 'Manage persistent goal execution', level: 'info' });
  });
});
