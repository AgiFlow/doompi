import { describe, expect, it, vi } from 'vitest';

import { DOOM_API_CALLER_LOCALITY_HEADER } from '../../../../../src/exports/packageApi';
import { remoteApi } from '../../../../../src/server/remoteApi';

function mount() {
  const fetch = vi.fn(async (_request: Request) => Response.json({ ok: true }));
  return { fetch, handler: remoteApi.start({ scope: 'global', onNotice: vi.fn(), remoteControl: { fetch } }) };
}

describe('remoteApi', () => {
  it('denies a sealed remote caller before reaching Remote Control', async () => {
    const { fetch, handler } = mount();

    const response = await handler.fetch(
      new Request('http://localhost/devices', { headers: { [DOOM_API_CALLER_LOCALITY_HEADER]: 'remote' } }),
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards a local caller to Remote Control', async () => {
    const { fetch, handler } = mount();

    const response = await handler.fetch(
      new Request('http://localhost/devices?all=1', { headers: { [DOOM_API_CALLER_LOCALITY_HEADER]: 'local' } }),
    );

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0].url).toBe('http://doompi.local/api/remote/devices?all=1');
  });

  it('denies a foreign origin', async () => {
    const { fetch, handler } = mount();

    const response = await handler.fetch(
      new Request('http://localhost/devices', { headers: { origin: 'https://evil.example' } }),
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
