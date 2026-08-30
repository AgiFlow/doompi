import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvePairing,
  denyPairing,
  disableRemoteAccess,
  enableRemoteAccess,
  fetchRemoteState,
  mintPairingCode,
  revokeDevice,
  saveRemoteSettings,
} from '../../src/web/lib/remoteApi.ts';

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

function answers(body: unknown, status = 200): string[] {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return calls;
}

const STATE = { state: { status: 'on', devices: [], pending: [], settings: {} } };

describe('remoteApi', () => {
  it('reads the state', async () => {
    const calls = answers(STATE);
    await expect(fetchRemoteState()).resolves.toEqual(STATE);
    expect(calls).toEqual(['GET /api/remote']);
  });

  it('names the routes for each control action', async () => {
    const calls = answers(STATE);
    await enableRemoteAccess();
    await disableRemoteAccess();
    await approvePairing('req 1');
    await denyPairing('req 1');
    await revokeDevice('dev/1');
    expect(calls).toEqual([
      'POST /api/remote/enable',
      'POST /api/remote/disable',
      // Ids are escaped, so one carrying a slash cannot reach another route.
      'POST /api/remote/pairing/req%201/approve',
      'POST /api/remote/pairing/req%201/deny',
      'DELETE /api/remote/devices/dev%2F1',
    ]);
  });

  it('reports when enabling hands the cockpit over to its container', async () => {
    answers({ ...STATE, handingOver: true });
    await expect(enableRemoteAccess()).resolves.toEqual({ ...STATE, handingOver: true });
  });

  it('reads a minted QR token and manual pairing code', async () => {
    answers({
      code: 'abc',
      manualCode: '12345678',
      pairUrl: 'https://x/pair#c=abc',
      expiresAt: '2026-01-01T00:00:00.000Z',
      publicKey: 'A'.repeat(90),
      fingerprint: 'f'.repeat(64),
      revision: 7,
    });
    await expect(mintPairingCode()).resolves.toMatchObject({ code: 'abc', manualCode: '12345678' });
  });

  it('sends only the settings it was given', async () => {
    let sent = '';
    globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent = typeof init?.body === 'string' ? init.body : '';
      return new Response(JSON.stringify({ settings: { autoCloseEnabled: false } }));
    }) as unknown as typeof fetch;
    await saveRemoteSettings({ autoCloseEnabled: false });
    expect(JSON.parse(sent)).toEqual({ autoCloseEnabled: false });
  });

  it('turns a refusal into an error the dialog can render', async () => {
    answers({ error: 'Remote access is not on.' }, 409);
    await expect(mintPairingCode()).resolves.toEqual({ error: 'Remote access is not on.' });
  });

  it('names the status when the body carries no error', async () => {
    answers({ nothing: true }, 500);
    await expect(fetchRemoteState()).resolves.toEqual({ error: 'The hub answered 500.' });
  });

  it('reports an unreachable hub rather than throwing', async () => {
    // One shape for every failure, so the dialog has a single branch to render.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(fetchRemoteState()).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });

  it('treats a 200 that is missing the field as a failure', async () => {
    answers({ notTheState: true });
    await expect(fetchRemoteState()).resolves.toEqual({ error: 'The hub answered 200.' });
  });
});
