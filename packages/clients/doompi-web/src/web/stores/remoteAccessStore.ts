import { Store } from '@tanstack/store';
import type { RemoteAccessSettings, RemoteAccessStateView } from '../../types/remoteAccess.ts';
import { passkeysAvailable, registerPasskey } from '../lib/webauthnClient.ts';
import { sealedHttpSession } from '../lib/sealedSession.ts';
import {
  approvePairing,
  denyPairing,
  disableRemoteAccess,
  enableRemoteAccess,
  fetchRemoteState,
  mintPairingCode,
  revokeDevice,
  saveRemoteSettings,
} from '../lib/remoteApi.ts';

/** Which panel of the dialog is showing. Options first, then the code to scan. */
export type RemoteStep = 'closed' | 'options' | 'handover' | 'pairing';

export interface PasskeySupportView {
  supported: boolean;
  reason?: string;
  count: number;
}

export interface RemoteAccessState {
  step: RemoteStep;
  /** Undefined until the passkey surface has been asked about. */
  passkeys?: PasskeySupportView;
  /** Undefined until the first load answers. */
  view?: RemoteAccessStateView;
  /** The URL the QR encodes; present only while a code is live. */
  pairUrl?: string;
  /** Short code accepted by the same pairing claim for manual entry. */
  pairCode?: string;
  /** Signing-key fingerprint the user compares during manual pairing. */
  pairFingerprint?: string;
  pairRevision?: number;
  pairExpiresAt?: string;
  busy: boolean;
  error?: string;
}

export const remoteAccessStore = new Store<RemoteAccessState>({ step: 'closed', busy: false });

function set(patch: Partial<RemoteAccessState>): void {
  remoteAccessStore.setState((state) => ({ ...state, ...patch }));
}

/** Clears the previous error before an action, so a stale one never outlives its cause. */
function begin(): void {
  set({ busy: true, error: undefined });
}

function settle(outcome: { state: RemoteAccessStateView } | { error: string }): boolean {
  if ('error' in outcome) {
    set({ busy: false, error: outcome.error });
    return false;
  }
  set({ busy: false, view: outcome.state });
  return true;
}

export function openRemoteDialog(): void {
  set({ step: 'options', error: undefined });
  void refreshRemoteState();
}

export function closeRemoteDialog(): void {
  // The code is left to expire on its own rather than cancelled here: closing
  // the dialog while a phone is mid-scan should not strand it.
  set({ step: 'closed', error: undefined });
}

export function showRemoteOptions(): void {
  set({ step: 'options', error: undefined });
}

/** Whether this tunnel and this browser can carry a passkey at all. */
export async function refreshPasskeys(): Promise<void> {
  try {
    const response = await sealedHttpSession.fetch('/api/remote/passkeys', { credentials: 'same-origin' });
    if (!response.ok) return;
    const body = (await response.json()) as {
      support: { supported: boolean; reason?: string };
      credentials: unknown[];
    };
    set({
      passkeys: {
        supported: body.support.supported && passkeysAvailable(),
        ...(body.support.reason === undefined ? {} : { reason: body.support.reason }),
        count: body.credentials.length,
      },
    });
  } catch {
    // The hub is unreachable; the state refresh reports that already.
  }
}

export async function addPasskey(): Promise<void> {
  begin();
  const outcome = await registerPasskey();
  set({ busy: false, ...(outcome.ok ? {} : { error: outcome.error }) });
  await refreshPasskeys();
}

export async function refreshRemoteState(): Promise<void> {
  const outcome = await fetchRemoteState();
  if ('error' in outcome) {
    set({ error: outcome.error });
    return;
  }
  set({ view: outcome.state });
}

/** Turns the tunnel on and moves straight to the code, which is what the user came for. */
export async function turnRemoteAccessOn(): Promise<void> {
  begin();
  const outcome = await enableRemoteAccess();
  if (!settle(outcome)) return;
  // A contained cockpit is about to close this hub and open another on the same
  // port. Nothing can be asked of it in between, so the dialog waits for the
  // socket to come back rather than calling into a server that is going away.
  if ('handingOver' in outcome && outcome.handingOver === true) {
    set({ step: 'handover' });
    return;
  }
  await Promise.all([newPairingCode(), refreshPasskeys()]);
  set({ step: 'pairing' });
}

export async function turnRemoteAccessOff(): Promise<void> {
  begin();
  if (!settle(await disableRemoteAccess())) return;
  set({
    step: 'options',
    pairUrl: undefined,
    pairCode: undefined,
    pairFingerprint: undefined,
    pairRevision: undefined,
    pairExpiresAt: undefined,
  });
}

export async function newPairingCode(): Promise<void> {
  const minted = await mintPairingCode();
  if ('error' in minted) {
    set({
      error: minted.error,
      pairUrl: undefined,
      pairCode: undefined,
      pairFingerprint: undefined,
      pairRevision: undefined,
    });
    return;
  }
  set({
    pairUrl: minted.pairUrl,
    pairCode: minted.manualCode,
    pairFingerprint: minted.fingerprint,
    pairRevision: minted.revision,
    pairExpiresAt: minted.expiresAt,
  });
}

export async function approveDevice(requestId: string): Promise<void> {
  settle(await approvePairing(requestId));
}

export async function denyDevice(requestId: string): Promise<void> {
  settle(await denyPairing(requestId));
}

export async function revokePairedDevice(id: string): Promise<void> {
  begin();
  settle(await revokeDevice(id));
}

export async function updateRemoteSettings(patch: Partial<RemoteAccessSettings>): Promise<void> {
  // Applied locally first so a toggle does not lag a round trip, then
  // reconciled from whatever the hub actually stored after clamping.
  const view = remoteAccessStore.state.view;
  if (view !== undefined) set({ view: { ...view, settings: { ...view.settings, ...patch } } });
  const outcome = await saveRemoteSettings(patch);
  if ('error' in outcome) {
    set({ error: outcome.error });
    void refreshRemoteState();
    return;
  }
  const current = remoteAccessStore.state.view;
  if (current !== undefined) set({ view: { ...current, settings: outcome.settings } });
}

/** Applies a state frame the hub pushed, so the page never polls for this. */
export function applyRemoteState(view: RemoteAccessStateView): void {
  const waiting = remoteAccessStore.state.step === 'handover';
  set({ view });
  // The first frame from the cockpit that took over. It reaches here because
  // the socket reconnected on its own, which is the only signal the browser
  // gets that the move finished.
  if (waiting && view.status === 'on') {
    void Promise.all([newPairingCode(), refreshPasskeys()]).then(() => {
      set({ step: 'pairing' });
    });
  }
}
