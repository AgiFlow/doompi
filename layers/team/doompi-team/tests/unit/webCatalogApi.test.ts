import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { launchAgent } from '../../src/web/api/catalog';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({
  sealedTransport: { fetch: vi.fn() },
}));

describe('web Team launch', () => {
  beforeEach(() => vi.resetAllMocks());

  it('posts a run to the selected session API and returns its ID', async () => {
    vi.mocked(sealedTransport.fetch).mockResolvedValue(Response.json({ runId: 'run-1' }, { status: 201 }));

    await expect(launchAgent('session-1', { agent: 'reviewer', task: 'Review', fork: false })).resolves.toBe('run-1');
    expect(sealedTransport.fetch).toHaveBeenCalledWith('/api/sessions/session-1/plugin/team/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'reviewer', task: 'Review', fork: false }),
    });
  });

  it('surfaces the server reason instead of treating a failed launch as pending', async () => {
    vi.mocked(sealedTransport.fetch).mockResolvedValue(
      Response.json({ error: 'Agent is unavailable.' }, { status: 409 }),
    );
    await expect(launchAgent('session-1', { agent: 'missing', task: '', fork: false })).rejects.toThrow(
      'Agent is unavailable.',
    );
  });
});
