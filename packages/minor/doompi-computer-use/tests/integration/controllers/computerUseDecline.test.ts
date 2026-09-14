import type {
  DoomHubChannelHost,
  DoomHubSessionApiRequest,
  DoomHubSessionScope,
} from '@agimon-ai/doompi-core/hub-channel';
import { DOOM_API_CALLER_LOCALITY_HEADER, DOOM_API_CALLER_STEP_UP_HEADER } from '@agimon-ai/doompi-core/package-api';
import { describe, expect, it, vi } from 'vitest';

import { createComputerUseApi } from '../../../src/controllers/computerUseApi';
import { createComputerUseChannel } from '../../../src/controllers/webComputerUseChannel';
import { COMPUTER_USE_ROUTES } from '../../../src/types/computerUseApi';

const scope: DoomHubSessionScope = { sessionId: 'session-1', cwd: '/repo' };
const DESKTOP_UNAVAILABLE = 'DoomPi Desktop computer use is unavailable.';
const HUB_TOKEN = 'hub';
const local = { [DOOM_API_CALLER_LOCALITY_HEADER]: 'local', [DOOM_API_CALLER_STEP_UP_HEADER]: 'not-required' };

/** Wires the hub channel to a real broker so the declined activation crosses the API boundary. */
function fixture() {
  const broker = createComputerUseApi({
    sessionId: scope.sessionId,
    hubToken: HUB_TOKEN,
    directEvents: { publish: () => undefined, subscribe: () => () => undefined, close: () => undefined },
  });
  const publish = vi.fn();
  const onNotice = vi.fn();
  const host = {
    directEvents: { publish: vi.fn(), subscribe: vi.fn(() => () => undefined), close: vi.fn() },
    publish,
    onNotice,
    requestSessionApi: (_scope: DoomHubSessionScope, request: DoomHubSessionApiRequest) =>
      broker.fetch(
        new Request(`http://host${request.path}`, {
          method: request.method ?? 'GET',
          headers: { authorization: `Bearer ${HUB_TOKEN}` },
          ...(request.body === undefined ? {} : { body: request.body }),
        }),
      ),
  } as unknown as DoomHubChannelHost;
  const channel = createComputerUseChannel();
  return { broker, channel, source: channel.start(host), publish, onNotice };
}

describe('computer-use activation without a Desktop host', () => {
  it('fails the session with desktop_unavailable instead of a server notice', async () => {
    const test = fixture();
    const accepted = await test.broker.fetch(
      new Request(`http://host${COMPUTER_USE_ROUTES.activate}`, {
        method: 'POST',
        headers: local,
        body: JSON.stringify({ target: { windowId: 'w1', bundleId: 'app.fixture' }, durationMs: 60_000 }),
      }),
    );
    expect(accepted.status).toBe(202);

    test.source.sessionAdded?.(scope);

    await vi.waitFor(() =>
      expect(test.broker.state()).toMatchObject({
        phase: 'failed',
        failure: { code: 'desktop_unavailable', message: DESKTOP_UNAVAILABLE },
      }),
    );
    expect(test.publish).toHaveBeenCalledWith(
      scope.sessionId,
      expect.objectContaining({
        state: expect.objectContaining({
          phase: 'failed',
          failure: { code: 'desktop_unavailable', message: DESKTOP_UNAVAILABLE },
        }),
        targets: [],
      }),
    );
    expect(test.onNotice).not.toHaveBeenCalled();

    test.channel.receive?.(scope, { action: 'targets' }, { connectionId: 'c1' });
    await vi.waitFor(() => expect(test.source.payloadFor(scope)).toMatchObject({ targets: [] }));
    expect(test.onNotice).not.toHaveBeenCalled();
    test.source.close();
    test.broker.close();
  });
});
