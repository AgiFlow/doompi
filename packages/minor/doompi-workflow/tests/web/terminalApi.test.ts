import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeEach as beforeEachApiRoutes } from 'vitest';
beforeEachApiRoutes(() => bindSessionApiWorkspace(() => 'test-workspace'));
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
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/terminalApi';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));

const fetch = vi.mocked(sealedTransport.fetch);
const eventSourceUrls: string[] = [];
const eventSources: FakeEventSource[] = [];

class FakeEventSource {
  readonly listeners = new Map<string, (message: MessageEvent<string>) => void>();
  closed = false;

  constructor(url: string | URL) {
    eventSourceUrls.push(String(url));
    eventSources.push(this);
  }

  addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    for (const listener of this.listeners.values()) listener({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

beforeEach(() => {
  fetch.mockReset();
  eventSourceUrls.length = 0;
  eventSources.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
});

describe('followScreen', () => {
  // EventSource reconnects on its own when the server ends a stream, so a finished run was
  // replayed for as long as its tab stayed open.
  it('closes the stream once the run settles', () => {
    const events: unknown[] = [];
    followScreen('repo/a', 'run', (event) => events.push(event), 'session/a');
    const source = eventSources[0]!;

    source.emit({ lines: ['working'], capabilities: {} });
    expect(source.closed).toBe(false);
    source.emit({ lines: ['done'], capabilities: {}, ended: true });

    expect(events).toHaveLength(2);
    expect(source.closed).toBe(true);
    expect(source.listeners.size).toBe(0);
  });
});

describe('workflow hub API bundle routing', () => {
  it('keeps the session selector after complete stream and artifact routes', () => {
    followScreen('repo/a', 'run one', () => undefined, 'session/a');

    expect(eventSourceUrls).toEqual([
      '/api/workspaces/test-workspace/sessions/session%2Fa/plugins/workflow/runs/repo%2Fa/run%20one/screen/stream',
    ]);
    expect(artifactContentUrl('repo/a', 'run one', 'reports/a b.md', false, 'session/a')).toBe(
      '/api/workspaces/test-workspace/sessions/session%2Fa/plugins/workflow/runs/repo%2Fa/run%20one/artifacts/reports/a%20b.md?raw=1',
    );
    expect(artifactContentUrl('repo/a', 'run one', 'report.md', true, 'session/a')).toContain('?raw=1&download=1');
  });

  it('addresses the hub itself when no session is named', async () => {
    fetch.mockImplementation(async () => Response.json({ artifacts: [] }));

    followScreen('repo/a', 'run one', () => undefined);
    await fetchArtifacts('repo', 'run');
    await fetchArtifact('repo', 'run', 'reports/a b.md');

    expect(eventSourceUrls).toEqual(['/api/plugins/workflow/runs/repo%2Fa/run%20one/screen/stream']);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/plugins/workflow/runs/repo/run/artifacts',
      '/api/plugins/workflow/runs/repo/run/artifacts/reports/a%20b.md',
    ]);
    expect(artifactContentUrl('repo', 'run', 'report.md')).toBe(
      '/api/plugins/workflow/runs/repo/run/artifacts/report.md?raw=1',
    );
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
      '/api/workspaces/test-workspace/sessions/session-a/plugins/workflow/runs/repo/run/control',
      '/api/workspaces/test-workspace/sessions/session-a/plugins/workflow/runs/repo/run/keys',
      '/api/workspaces/test-workspace/sessions/session-a/plugins/workflow/runs/repo/run/artifacts',
      '/api/workspaces/test-workspace/sessions/session-a/plugins/workflow/runs/repo/run/artifacts/report.md',
      '/api/workspaces/test-workspace/sessions/session-a/plugins/workflow/runs/repo/run',
    ]);
  });
});
