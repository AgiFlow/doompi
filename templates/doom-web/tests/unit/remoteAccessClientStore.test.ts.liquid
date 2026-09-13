import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRemoteState,
  closeRemoteDialog,
  newPairingCode,
  openRemoteDialog,
  remoteAccessStore,
  showRemoteOptions,
  turnRemoteAccessOff,
  turnRemoteAccessOn,
  updateRemoteSettings,
} from '../../src/web/stores/remoteAccessStore.ts';
import type { RemoteAccessStateView } from '../../src/types/remoteAccess.ts';

const originalFetch = globalThis.fetch;

const SETTINGS = {
  autoCloseEnabled: false,
  autoCloseMinutes: 60,
  sessionExpiryEnabled: false,
  idleMinutes: 30,
  absoluteHours: 12,
  tunnel: { kind: 'quick' as const },
  sandbox: { enabled: false, workspaces: [] },
};
const PAIRING_TRUST = { publicKey: 'A'.repeat(90), fingerprint: 'f'.repeat(64), revision: 1 };

function view(overrides: Partial<RemoteAccessStateView> = {}): RemoteAccessStateView {
  return { status: 'off', devices: [], pending: [], settings: SETTINGS, ...overrides };
}

/** Answers each route by the first fragment of its path that matters. */
function routes(table: Record<string, unknown>, status = 200): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const key = Object.keys(table).find((candidate) => url.includes(candidate));
    if (key === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(table[key]), { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  remoteAccessStore.setState(() => ({ step: 'closed', busy: false }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('the dialog', () => {
  it('opens on its options and reads the state', async () => {
    routes({ '/api/remote': { state: view({ status: 'on' }) } });
    openRemoteDialog();
    expect(remoteAccessStore.state.step).toBe('options');
    await vi.waitFor(() => {
      expect(remoteAccessStore.state.view?.status).toBe('on');
    });
  });

  it('closes without cancelling a code, so a mid-scan phone is not stranded', () => {
    remoteAccessStore.setState((state) => ({
      ...state,
      step: 'pairing',
      pairUrl: 'https://x/pair#c=a',
      pairCode: '12345678',
    }));
    closeRemoteDialog();
    expect(remoteAccessStore.state.step).toBe('closed');
    expect(remoteAccessStore.state.pairUrl).toBe('https://x/pair#c=a');
    expect(remoteAccessStore.state.pairCode).toBe('12345678');
  });

  it('goes back to the options panel', () => {
    remoteAccessStore.setState((state) => ({ ...state, step: 'pairing' }));
    showRemoteOptions();
    expect(remoteAccessStore.state.step).toBe('options');
  });
});

describe('turning it on', () => {
  it('lands on the code, which is what the user came for', async () => {
    routes({
      '/api/remote/enable': { state: view({ status: 'on' }) },
      '/api/remote/codes': {
        code: 'a',
        manualCode: '12345678',
        pairUrl: 'https://x/pair#c=a',
        expiresAt: 'now',
        ...PAIRING_TRUST,
      },
      '/api/remote/passkeys': { support: { supported: false, reason: 'quick tunnel' }, credentials: [] },
    });
    await turnRemoteAccessOn();
    expect(remoteAccessStore.state.step).toBe('pairing');
    expect(remoteAccessStore.state.pairUrl).toBe('https://x/pair#c=a');
    expect(remoteAccessStore.state.pairCode).toBe('12345678');
    expect(remoteAccessStore.state.busy).toBe(false);
  });

  it('stays on the options and shows why when the tunnel refuses', async () => {
    routes({ '/api/remote/enable': { error: 'cloudflared is not installed.' } }, 502);
    await turnRemoteAccessOn();
    expect(remoteAccessStore.state.step).toBe('closed');
    expect(remoteAccessStore.state.error).toContain('not installed');
    expect(remoteAccessStore.state.busy).toBe(false);
  });
});

describe('turning it off', () => {
  it('returns to the options and forgets the code', async () => {
    remoteAccessStore.setState((state) => ({
      ...state,
      step: 'pairing',
      pairUrl: 'https://x/pair#c=a',
      pairCode: '12345678',
    }));
    routes({ '/api/remote/disable': { state: view() } });
    await turnRemoteAccessOff();
    expect(remoteAccessStore.state.step).toBe('options');
    expect(remoteAccessStore.state.pairUrl).toBeUndefined();
    expect(remoteAccessStore.state.pairCode).toBeUndefined();
  });
});

describe('the pairing code', () => {
  it('clears a stale URL when a new code cannot be minted', async () => {
    remoteAccessStore.setState((state) => ({
      ...state,
      pairUrl: 'https://x/pair#c=old',
      pairCode: '87654321',
    }));
    routes({ '/api/remote/codes': { error: 'Remote access is not on.' } }, 409);
    await newPairingCode();
    expect(remoteAccessStore.state.pairUrl).toBeUndefined();
    expect(remoteAccessStore.state.pairCode).toBeUndefined();
    expect(remoteAccessStore.state.error).toContain('not on');
  });
});

describe('settings', () => {
  it('applies a toggle before the round trip, then takes what the hub stored', async () => {
    // Optimistic so a switch does not lag the network, reconciled so a clamped
    // value is what ends up on screen.
    applyRemoteState(view({ status: 'on' }));
    routes({ '/api/remote/settings': { settings: { ...SETTINGS, idleMinutes: 1440 } } });
    const pending = updateRemoteSettings({ idleMinutes: 99_999 });
    expect(remoteAccessStore.state.view?.settings.idleMinutes).toBe(99_999);
    await pending;
    expect(remoteAccessStore.state.view?.settings.idleMinutes).toBe(1440);
  });

  it('re-reads the state when the save is refused', async () => {
    applyRemoteState(view({ status: 'on' }));
    let reads = 0;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input).endsWith('/settings')) return new Response('{"error":"nope"}', { status: 400 });
      reads += 1;
      return new Response(JSON.stringify({ state: view({ status: 'on' }) }));
    }) as unknown as typeof fetch;

    await updateRemoteSettings({ idleMinutes: 45 });
    expect(remoteAccessStore.state.error).toBe('nope');
    await vi.waitFor(() => {
      expect(reads).toBe(1);
    });
  });
});

describe('pushed state', () => {
  it('takes a frame the hub sent without asking for it', () => {
    applyRemoteState(view({ status: 'on', publicUrl: 'https://x' }));
    expect(remoteAccessStore.state.view?.publicUrl).toBe('https://x');
  });
});

describe('waiting out a handover', () => {
  it('waits rather than asking a hub that is being replaced for a code', async () => {
    // Every call after this would hit a server that is closing, so the dialog
    // has to stop asking and wait for the socket to come back.
    let minted = 0;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/enable')) {
        return new Response(JSON.stringify({ state: view({ status: 'starting' }), handingOver: true }), {
          status: 202,
        });
      }
      if (url.includes('/codes')) minted += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await turnRemoteAccessOn();
    expect(remoteAccessStore.state.step).toBe('handover');
    expect(minted).toBe(0);
  });

  it('goes to the code once the cockpit that took over reports itself', async () => {
    routes({
      '/api/remote/codes': {
        code: 'c',
        manualCode: '12345678',
        pairUrl: 'https://x/pair#c=c',
        expiresAt: 'later',
        ...PAIRING_TRUST,
      },
      '/api/remote/passkeys': { support: { supported: false }, credentials: [] },
    });
    remoteAccessStore.setState((state) => ({ ...state, step: 'handover' }));
    applyRemoteState(view({ status: 'on' }));
    await vi.waitFor(() => {
      expect(remoteAccessStore.state.step).toBe('pairing');
    });
    expect(remoteAccessStore.state.pairUrl).toBe('https://x/pair#c=c');
    expect(remoteAccessStore.state.pairCode).toBe('12345678');
  });

  it('keeps waiting while the container is still coming up', () => {
    remoteAccessStore.setState((state) => ({ ...state, step: 'handover' }));
    applyRemoteState(view({ status: 'starting' }));
    expect(remoteAccessStore.state.step).toBe('handover');
  });

  it('goes straight to the code when the cockpit is not contained', async () => {
    routes({
      '/enable': { state: view({ status: 'on' }) },
      '/api/remote/codes': {
        code: 'c',
        manualCode: '12345678',
        pairUrl: 'https://x/pair#c=c',
        expiresAt: 'later',
        ...PAIRING_TRUST,
      },
      '/api/remote/passkeys': { support: { supported: false }, credentials: [] },
    });
    await turnRemoteAccessOn();
    expect(remoteAccessStore.state.step).toBe('pairing');
  });
});
