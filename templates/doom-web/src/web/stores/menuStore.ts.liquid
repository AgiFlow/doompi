import { Store } from '@tanstack/store';

/** A selection-bar axis name: the built-in 'mode'/'domains', or a plugin-declared axis such as 'profile'. */
export type MenuKind = string;

export interface MenuClaim {
  /** The agent dialog rendered as the bar's popover instead of the modal. */
  dialogId: string;
  menu: MenuKind;
}

export interface MenuState {
  /** Selection-bar button whose command is in flight, if any. */
  pending: MenuKind | null;
  /** When it was clicked; a stale anchor must not restyle an unrelated dialog. */
  at: number;
  /** The dialog the last click claimed, so the bar and the overlay agree who renders it. */
  claimed: MenuClaim | null;
}

const MENU_FRESH_MS = 10_000;

export const menuStore = new Store<MenuState>({ pending: null, at: 0, claimed: null });

let expiry: ReturnType<typeof setTimeout> | undefined;

/**
 * Remembers which selection-bar button asked the agent a question.
 *
 * The agent answers with an ordinary select dialog; this is the only signal
 * that lets the bar render it as its popover menu rather than a centered
 * modal. The button shows a pending state until the dialog arrives, the run
 * settles, or the anchor goes stale.
 */
export function setPendingMenu(kind: MenuKind): void {
  menuStore.setState((state) => ({ ...state, pending: kind, at: Date.now() }));
  if (expiry !== undefined) clearTimeout(expiry);
  expiry = setTimeout(clearPendingMenu, MENU_FRESH_MS);
}

export function clearPendingMenu(): void {
  if (expiry !== undefined) clearTimeout(expiry);
  expiry = undefined;
  menuStore.setState((state) => (state.pending === null ? state : { ...state, pending: null, at: 0 }));
}

/** The menu behind an arriving dialog, or null when none was asked for recently. */
export function pendingMenuFor(now: number): MenuKind | null {
  const { pending, at } = menuStore.state;
  if (pending === null || now - at > MENU_FRESH_MS) return null;
  return pending;
}

/**
 * Spends the pending anchor on an arriving select dialog. Called once per
 * dialog, at frame time, so every surface reads the same verdict on its
 * first render and the modal never flashes before the popover takes over.
 */
export function claimDialogMenu(dialogId: string, now = Date.now()): MenuClaim | null {
  const menu = pendingMenuFor(now);
  const claimed = menu === null ? null : { dialogId, menu };
  clearPendingMenu();
  menuStore.setState((state) => ({ ...state, claimed }));
  return claimed;
}

/** Forgets a claim once its dialog is gone. */
export function releaseDialogMenu(dialogId: string): void {
  menuStore.setState((state) =>
    state.claimed !== null && state.claimed.dialogId === dialogId ? { ...state, claimed: null } : state,
  );
}

/** Test seam. */
export function resetMenuStore(): void {
  clearPendingMenu();
  menuStore.setState(() => ({ pending: null, at: 0, claimed: null }));
}
