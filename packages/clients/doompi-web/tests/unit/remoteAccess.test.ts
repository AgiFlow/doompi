import { describe, expect, it, vi } from 'vitest';
import { createRemoteAccess, type TunnelListener } from '../../src/adapters/remoteAccess.ts';
import { DEFAULT_REMOTE_SETTINGS } from '../../src/services/remoteAccessSettings.ts';
import type { StoredCredential } from '../../src/services/webauthnPolicy.ts';
import type { RemoteAccessSettings, TunnelStartResult } from '../../src/types/remoteAccess.ts';

const START = 1_700_000_000_000;
const ORIGIN = 'https://doom.example.com';

function harness(
  overrides: {
    settings?: Partial<RemoteAccessSettings>;
    launch?: () => Promise<TunnelStartResult>;
    contained?: boolean;
    onHandover?: (settings: RemoteAccessSettings) => void;
  } = {},
) {
  let now = START;
  let settings: RemoteAccessSettings = { ...DEFAULT_REMOTE_SETTINGS, ...overrides.settings };
  const credentials: StoredCredential[] = [];
  const notices: string[] = [];
  const localFrames: object[] = [];
  const allFrames: object[] = [];
  let stopped = 0;
  let closed = 0;

  const remote = createRemoteAccess({
    store: {
      directory: '/tmp/nowhere',
      settings: () => settings,
      save: (next) => (settings = next),
      credentials: () => credentials,
      saveCredential: (credential) => credentials.push(credential),
      removeCredential: () => false,
    },
    launchTunnel:
      overrides.launch ??
      (async () => ({
        ok: true,
        publicOrigin: ORIGIN,
        stop: async () => {
          stopped += 1;
        },
      })),
    bindListener: async (): Promise<TunnelListener> => ({
      port: 54_321,
      close: async () => {
        closed += 1;
      },
    }),
    onNotice: (message) => notices.push(message),
    ...(overrides.contained === undefined ? {} : { contained: overrides.contained }),
    ...(overrides.onHandover === undefined ? {} : { requestHandover: overrides.onHandover }),
    broadcastLocal: (frame) => localFrames.push(frame),
    broadcastAll: (frame) => allFrames.push(frame),
    now: () => now,
  });

  return {
    remote,
    notices,
    localFrames,
    allFrames,
    counts: () => ({ stopped, closed }),
    advance: (ms: number) => (now += ms),
  };
}

describe('turning remote access on', () => {
  it('reports the tunnel and a channel key once it is up', async () => {
    const { remote } = harness();
    await expect(remote.enable()).resolves.toEqual({ ok: true });
    expect(remote.state().status).toBe('on');
    expect(remote.state().publicUrl).toBe(ORIGIN);
    expect(remote.tunnelPort()).toBe(54_321);
    expect(remote.tunnelPolicy()).toBeDefined();
    expect(remote.channelPublicKey()).toBeTruthy();
  });

  it('is idempotent while already on', async () => {
    const { remote, counts } = harness();
    await remote.enable();
    await expect(remote.enable()).resolves.toEqual({ ok: true });
    expect(counts().closed).toBe(0);
  });

  it('tears everything down when the tunnel refuses', async () => {
    const { remote, counts } = harness({
      launch: async () => ({ ok: false, failure: 'not_installed', message: 'no cloudflared' }),
    });
    await expect(remote.enable()).resolves.toEqual({ ok: false, error: 'no cloudflared' });
    expect(remote.state().status).toBe('failed');
    expect(remote.tunnelPort()).toBeUndefined();
    expect(counts().closed).toBe(1);
  });
});

describe('the auto-close timer', () => {
  it('does not arm while the toggle is off', async () => {
    const { remote } = harness();
    await remote.enable();
    expect(remote.state().closesAt).toBeUndefined();
  });

  it('names a deadline while the toggle is on', async () => {
    const { remote } = harness({ settings: { autoCloseEnabled: true, autoCloseMinutes: 60 } });
    await remote.enable();
    expect(remote.state().closesAt).toBe(new Date(START + 60 * 60_000).toISOString());
  });

  it('re-arms when the window is changed mid-session', async () => {
    // Shortening the window has to take effect now, not at the old deadline.
    const { remote } = harness({ settings: { autoCloseEnabled: true, autoCloseMinutes: 60 } });
    await remote.enable();
    remote.updateSettings({ autoCloseMinutes: 5 });
    expect(remote.state().closesAt).toBe(new Date(START + 5 * 60_000).toISOString());
  });

  it('closes the tunnel when the timer fires', async () => {
    vi.useFakeTimers();
    try {
      const { remote, counts } = harness({ settings: { autoCloseEnabled: true, autoCloseMinutes: 1 } });
      await remote.enable();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(counts().stopped).toBe(1);
      expect(remote.state().status).toBe('off');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('switching off', () => {
  it('stops the tunnel, closes the listener, and forgets the channel key', async () => {
    const { remote, counts } = harness();
    await remote.enable();
    await remote.disable();
    expect(counts()).toEqual({ stopped: 1, closed: 1 });
    expect(remote.channelPublicKey()).toBeUndefined();
    expect(remote.tunnelPolicy()).toBeUndefined();
  });

  it('does nothing when already off', async () => {
    const { remote, counts } = harness();
    await remote.disable();
    expect(counts()).toEqual({ stopped: 0, closed: 0 });
  });

  it('closes every tracked socket, so a phone stops driving the agent', async () => {
    const { remote } = harness();
    await remote.enable();
    const closes: number[] = [];
    remote.trackSocket((code) => closes.push(code));
    await remote.disable();
    expect(closes).toEqual([1008]);
  });

  it('lets a socket withdraw itself before teardown', async () => {
    const { remote } = harness();
    await remote.enable();
    const closes: number[] = [];
    const untrack = remote.trackSocket((code) => closes.push(code));
    untrack();
    await remote.disable();
    expect(closes).toEqual([]);
  });
});

describe('the sealed channel', () => {
  it('is only offered once a tunnel is up', () => {
    const { remote } = harness();
    expect(remote.channelPublicKey()).toBeUndefined();
    expect(remote.openChannel('device', 'anything')).toBe(false);
  });

  it('refuses a key that is not a point on the curve', async () => {
    const { remote } = harness();
    await remote.enable();
    expect(remote.openChannel('device', 'bm90LWEta2V5')).toBe(false);
    expect(remote.channelFor('device')).toBeUndefined();
  });

  it('drops the channel of a device that is revoked', async () => {
    const { remote } = harness();
    await remote.enable();
    const enrolled = remote.sessionForPasskey('iPhone');
    expect(remote.authorize(enrolled.token)).toBe(enrolled.record.id);
    remote.revokeDevice(enrolled.record.id);
    expect(remote.channelFor(enrolled.record.id)).toBeUndefined();
    expect(remote.authorize(enrolled.token)).toBeUndefined();
  });
});

describe('settings while running', () => {
  it('clamps a value the caller pushed out of range', async () => {
    const { remote, notices } = harness();
    await remote.enable();
    const settings = remote.updateSettings({ idleMinutes: 99_999 });
    expect(settings.idleMinutes).toBe(1440);
    expect(notices.some((message) => message.includes('idleMinutes'))).toBe(true);
  });

  it('publishes the change so every page sees it', async () => {
    const { remote, allFrames } = harness();
    await remote.enable();
    const before = allFrames.length;
    remote.updateSettings({ idleMinutes: 45 });
    expect(allFrames.length).toBeGreaterThan(before);
  });

  it('disarms the timer when auto-close is switched off mid-session', async () => {
    const { remote } = harness({ settings: { autoCloseEnabled: true, autoCloseMinutes: 60 } });
    await remote.enable();
    expect(remote.state().closesAt).toBeDefined();
    remote.updateSettings({ autoCloseEnabled: false });
    expect(remote.state().closesAt).toBeUndefined();
  });
});

describe('what each side is told', () => {
  it('keeps the approval queue out of a remote view', async () => {
    const { remote } = harness();
    await remote.enable();
    const minted = remote.mintPairing();
    if (minted === undefined) throw new Error('no code');
    remote.claim({ code: minted.code, userAgent: 'iPhone', edgeIp: '203.0.113.7' });
    expect(remote.state(undefined, true).pending).toHaveLength(1);
    expect(remote.state(undefined, false).pending).toHaveLength(0);
  });

  it('sends a pairing request to local pages only', async () => {
    const { remote, localFrames, allFrames } = harness();
    await remote.enable();
    const before = allFrames.length;
    const minted = remote.mintPairing();
    if (minted === undefined) throw new Error('no code');
    remote.claim({ code: minted.code, userAgent: 'iPhone', edgeIp: '203.0.113.7' });
    expect(localFrames).toHaveLength(1);
    expect(allFrames).toHaveLength(before);
  });

  it('mints no code while remote access is off', () => {
    expect(harness().remote.mintPairing()).toBeUndefined();
  });

  it('puts the channel key in the fragment alongside the code', async () => {
    const { remote } = harness();
    await remote.enable();
    const minted = remote.mintPairing();
    if (minted === undefined) throw new Error('no code');
    const hash = new URL(minted.pairUrl).hash.slice(1);
    const params = new URLSearchParams(hash);
    expect(params.get('c')).toBe(minted.code);
    expect(params.get('k')).toBe(remote.channelPublicKey());
    expect(new URL(minted.pairUrl).search).toBe('');
  });

  it('rejects a denied request and drops it from the queue', async () => {
    const { remote } = harness();
    await remote.enable();
    const minted = remote.mintPairing();
    if (minted === undefined) throw new Error('no code');
    const claimed = remote.claim({ code: minted.code, userAgent: 'iPhone', edgeIp: '203.0.113.7' });
    if (!claimed.ok) throw new Error('claim failed');
    expect(remote.deny(claimed.requestId)).toBe('denied');
    expect(remote.state(undefined, true).pending).toHaveLength(0);
    expect(remote.redeem(claimed.requestId)).toBeUndefined();
  });
});

describe('handing over to a container', () => {
  const contained = { sandbox: { enabled: true, workspaces: ['/repo'] } };

  it('holds the handover rather than running it inside the enable', async () => {
    const handed: RemoteAccessSettings[] = [];
    const { remote } = harness({ settings: contained, onHandover: (settings) => handed.push(settings) });
    expect(await remote.enable()).toEqual({ ok: true });
    // Nothing yet: the response for this very call still has to reach the wire.
    expect(handed).toEqual([]);
    expect(remote.handoverPending()).toBe(true);
    remote.commitHandover();
    expect(handed[0]?.sandbox).toEqual({ enabled: true, workspaces: ['/repo'] });
    expect(remote.handoverPending()).toBe(false);
  });

  it('starts no tunnel of its own, because the container starts one inside', async () => {
    let launched = 0;
    const { remote } = harness({
      settings: contained,
      onHandover: () => {},
      launch: async () => {
        launched += 1;
        return { ok: true, publicOrigin: ORIGIN, stop: async () => {} };
      },
    });
    await remote.enable();
    remote.commitHandover();
    expect(launched).toBe(0);
    expect(remote.state(undefined, true).publicUrl).toBeUndefined();
  });

  it('runs the handover only once, however often it is committed', async () => {
    let handed = 0;
    const { remote } = harness({
      settings: contained,
      onHandover: () => {
        handed += 1;
      },
    });
    await remote.enable();
    remote.commitHandover();
    remote.commitHandover();
    expect(handed).toBe(1);
  });

  it('refuses to hand over with nothing mounted, since the container could not work anywhere', async () => {
    const { remote } = harness({
      settings: { sandbox: { enabled: true, workspaces: [] } },
      onHandover: () => {},
    });
    const outcome = await remote.enable();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('workspace');
    expect(remote.state(undefined, true).status).toBe('failed');
  });

  it('refuses when this cockpit has no way to hand over at all', async () => {
    const { remote } = harness({ settings: contained });
    const outcome = await remote.enable();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('cannot hand over');
  });

  it('starts a tunnel normally once it is the cockpit inside the container', async () => {
    // Without this the contained hub would read the settings it was handed and
    // try to start a container inside a container.
    let handed = 0;
    const { remote } = harness({
      settings: contained,
      contained: true,
      onHandover: () => {
        handed += 1;
      },
    });
    expect(await remote.enable()).toEqual({ ok: true });
    expect(handed).toBe(0);
    expect(remote.state(undefined, true).publicUrl).toBe(ORIGIN);
  });
});
