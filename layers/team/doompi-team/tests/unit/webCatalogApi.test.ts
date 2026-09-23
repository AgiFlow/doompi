import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeEach as beforeEachApiRoutes } from 'vitest';
beforeEachApiRoutes(() => bindSessionApiWorkspace(() => 'test-workspace'));
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { launchAgent, steerRun, stopRun } from '../../src/extensions/workspaces/sessions/(frontend)/_lib/catalog';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({
  sealedTransport: { fetch: vi.fn() },
}));

describe('web Team launch', () => {
  beforeEach(() => vi.resetAllMocks());

  it('posts a run to the selected session API and returns its ID', async () => {
    vi.mocked(sealedTransport.fetch).mockResolvedValue(Response.json({ runId: 'run-1' }, { status: 201 }));

    await expect(launchAgent('session-1', { agent: 'reviewer', task: 'Review', fork: false })).resolves.toBe('run-1');
    expect(sealedTransport.fetch).toHaveBeenCalledWith(
      '/api/workspaces/test-workspace/sessions/session-1/plugins/team/run',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'reviewer', task: 'Review', fork: false }),
      },
    );
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

describe('web Team run control', () => {
  beforeEach(() => vi.resetAllMocks());

  it('posts guidance to the selected session API and returns the run answer', async () => {
    const pending = { state: 'pending', message: 'No child acknowledgment arrived within 3 seconds.' };
    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(Response.json({ requestId: 'req-1', index: 0, ...pending }));

    await expect(steerRun('session-1', 'run-1', 'check the edge case')).resolves.toEqual(pending);
    expect(sealedTransport.fetch).toHaveBeenCalledWith(
      '/api/workspaces/test-workspace/sessions/session-1/plugins/team/steer',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1', message: 'check the edge case' }),
      },
    );
  });

  it('surfaces a refused steer and rejects an unknown answer', async () => {
    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(
      Response.json({ error: 'This run is not active.' }, { status: 404 }),
    );
    await expect(steerRun('session-1', 'run-1', 'go')).rejects.toThrow('This run is not active.');

    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(Response.json({ state: 'queued', message: 'x' }));
    await expect(steerRun('session-1', 'run-1', 'go')).rejects.toThrow('The server returned an invalid steer result.');
  });

  it('posts a stop to the selected session API and surfaces a refusal', async () => {
    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(Response.json({ requestId: 'req-stop' }));
    await expect(stopRun('session-1', 'run-1')).resolves.toBeUndefined();
    expect(sealedTransport.fetch).toHaveBeenCalledWith(
      '/api/workspaces/test-workspace/sessions/session-1/plugins/team/stop',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run-1' }),
      },
    );

    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(
      Response.json({ error: 'External run is no longer active.' }, { status: 409 }),
    );
    await expect(stopRun('session-1', 'run-1')).rejects.toThrow('External run is no longer active.');
  });
});
