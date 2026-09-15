import { describe, expect, it, vi } from 'vitest';

import { createAuthorCommand } from '../../../src/services/authorCommand';

describe('Author command', () => {
  it('delivers its result through the shared notification capability', async () => {
    const notify = vi.fn();
    await createAuthorCommand().execute('', { cwd: '/repo', notify });
    expect(notify).toHaveBeenCalledWith({ body: 'Open the Author visual steering workspace', level: 'info' });
  });
});
