import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactContentUrl,
  deleteWorkflowRun,
  fetchArtifact,
  fetchArtifacts,
  followScreen,
  sendKeys,
  takeControl,
} from '../../src/web/api/terminalApi.ts';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));

const fetch = vi.mocked(sealedTransport.fetch);
const eventSourceUrls: string[] = [];

class FakeEventSource {
  constructor(url: string | URL) {
    eventSourceUrls.push(String(url));
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  fetch.mockReset();
  eventSourceUrls.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
});

describe('workflow hub API bundle routing', () => {
  it('keeps the session selector after complete stream and artifact routes', () => {
    followScreen('repo/a', 'run one', () => undefined, 'session/a');

    expect(eventSourceUrls).toEqual([
      '/api/sessions/session%2Fa/plugin/workflow/runs/repo%2Fa/run%20one/screen/stream',
    ]);
    expect(artifactContentUrl('repo/a', 'run one', 'reports/a b.md', false, 'session/a')).toBe(
      '/api/sessions/session%2Fa/plugin/workflow/runs/repo%2Fa/run%20one/artifacts/reports/a%20b.md?raw=1',
    );
    expect(artifactContentUrl('repo/a', 'run one', 'report.md', true, 'session/a')).toContain('?raw=1&download=1');
  });

  it('routes reads, writes, and deletion through the selected session bundle', async () => {
    fetch.mockImplementation(async (_input, init) => {
      if (init?.method === 'DELETE') return Response.json({ deleted: true });
      if (init?.method === 'POST') return Response.json({ held: true, token: 'token' });
      return Response.json({ artifacts: [] });
    });

    await takeControl('repo', 'run', undefined, 'session-a');
    await sendKeys('repo', 'run', 'token', 'x', 'session-a');
    await fetchArtifacts('repo', 'run', 'session-a');
    await fetchArtifact('repo', 'run', 'report.md', 'session-a');
    await deleteWorkflowRun('repo', 'run', 'session-a');

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/sessions/session-a/plugin/workflow/runs/repo/run/control',
      '/api/sessions/session-a/plugin/workflow/runs/repo/run/keys',
      '/api/sessions/session-a/plugin/workflow/runs/repo/run/artifacts',
      '/api/sessions/session-a/plugin/workflow/runs/repo/run/artifacts/report.md',
      '/api/sessions/session-a/plugin/workflow/runs/repo/run',
    ]);
  });
});
