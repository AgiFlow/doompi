import { Store } from '@tanstack/store';

/** A selection-bar axis name: the built-in 'mode'/'domains', or a plugin-declared axis such as 'profile'. */
export type MenuKind = string;

export interface MenuState {
  /** Selection-bar button whose command is in flight, if any. */
  pending: MenuKind | null;
  /** When it was clicked; a stale anchor must not restyle an unrelated dialog. */
  at: number;
}

const MENU_FRESH_MS = 10_000;

export const menuStore = new Store<MenuState>({ pending: null, at: 0 });

/**
 * Remembers which selection-bar button asked the agent a question.
 *
 * The agent answers with an ordinary select dialog; this is the only signal
 * that lets the overlay render it as the bar's popover menu rather than a
 * centered modal.
 */
export function setPendingMenu(kind: MenuKind): void {
  menuStore.setState(() => ({ pending: kind, at: Date.now() }));
}

export function clearPendingMenu(): void {
  menuStore.setState((state) => (state.pending === null ? state : { pending: null, at: 0 }));
}

/** The menu behind an arriving dialog, or null when none was asked for recently. */
export function pendingMenuFor(now: number): MenuKind | null {
  const { pending, at } = menuStore.state;
  if (pending === null || now - at > MENU_FRESH_MS) return null;
  return pending;
}
