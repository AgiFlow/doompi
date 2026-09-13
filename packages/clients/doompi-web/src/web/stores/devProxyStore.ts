import { Store } from '@tanstack/store';

import type { DevProxyTarget } from '../../types/devProxy';
import { addDevProxyTarget, fetchDevProxyTargets, removeDevProxyTarget } from '../lib/devProxyApi';

/**
 * Registered dev proxy targets, as the remote dialog shows them.
 *
 * `canRegister` comes from the hub rather than being guessed here: adding a
 * target is refused anywhere but the loopback listener, and a phone that
 * rendered an enabled form would only be offering a button that fails.
 */

export interface DevProxyState {
  targets: readonly DevProxyTarget[];
  /** False on a remote device, where registering is refused by the hub. */
  canRegister: boolean;
  busy: boolean;
  error?: string;
}

export const devProxyStore = new Store<DevProxyState>({ targets: [], canRegister: false, busy: false });

function set(patch: Partial<DevProxyState>): void {
  devProxyStore.setState((state) => ({ ...state, ...patch }));
}

export async function refreshDevProxyTargets(): Promise<void> {
  const outcome = await fetchDevProxyTargets();
  if ('error' in outcome) {
    set({ error: outcome.error });
    return;
  }
  set({ targets: outcome.state.targets, canRegister: outcome.state.canRegister, error: undefined });
}

export async function createDevProxyTarget(name: string, port: number): Promise<boolean> {
  set({ busy: true, error: undefined });
  const outcome = await addDevProxyTarget(name, port);
  if ('error' in outcome) {
    set({ busy: false, error: outcome.error });
    return false;
  }
  set({ busy: false });
  await refreshDevProxyTargets();
  return true;
}

export async function deleteDevProxyTarget(name: string): Promise<void> {
  set({ busy: true, error: undefined });
  const outcome = await removeDevProxyTarget(name);
  set({ busy: false, ...('error' in outcome ? { error: outcome.error } : {}) });
  await refreshDevProxyTargets();
}

/** Test seam. */
export function resetDevProxyStore(): void {
  devProxyStore.setState(() => ({ targets: [], canRegister: false, busy: false }));
}
