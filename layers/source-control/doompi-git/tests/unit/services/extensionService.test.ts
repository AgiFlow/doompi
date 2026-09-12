// @scaffold-generated
import { describe, expect, it } from 'vitest';
import { DefaultGitExtensionService } from '../../../src/services/extensionService';

describe('DefaultGitExtensionService', () => {
  it('returns the command result without depending on a host API', async () => {
    const service = new DefaultGitExtensionService();

    await expect(service.execute()).resolves.toEqual({
      message: 'Show git worktrees owned by this session',
      level: 'info',
    });
  });
});
