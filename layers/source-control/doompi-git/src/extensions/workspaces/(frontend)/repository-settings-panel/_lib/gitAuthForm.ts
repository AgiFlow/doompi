import type { GitAuthMethod, GitAuthSaveRequest, GitAuthView } from '../../../../../types/gitAuth';

/**
 * Pure form logic for a workspace's git auth panel: what the fields start as,
 * what is wrong with them, and what a save sends.
 *
 * The server validates again; this only keeps the page from sending what it
 * already knows will be refused, and says why in words next to the field.
 */

export const DEFAULT_HTTPS_HOST = 'github.com';

export interface GitAuthFormState {
  method: GitAuthMethod;
  keyPath: string;
  host: string;
  username: string;
  /** Never prefilled. Empty keeps the saved token when there is one for this host. */
  token: string;
}

export function formFromView(view: GitAuthView): GitAuthFormState {
  return {
    method: view.method,
    keyPath: view.ssh?.keyPath ?? '',
    host: view.https?.host ?? DEFAULT_HTTPS_HOST,
    username: view.https?.username ?? '',
    token: '',
  };
}

const HOST_PATTERN = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/u;
/** Whether a value holds an ASCII control character; a newline in a credential field could add a line to git's credential protocol. */
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Whether the saved token can stay: only when one exists and the host has not moved. */
function keepsToken(form: GitAuthFormState, saved: GitAuthView): boolean {
  return saved.https?.hasToken === true && saved.https.host === form.host.trim().toLowerCase();
}

/** The first thing wrong with the form, in words, or undefined when it can be saved. */
export function formProblem(form: GitAuthFormState, saved: GitAuthView): string | undefined {
  if (form.method === 'ssh') {
    const keyPath = form.keyPath.trim();
    if (keyPath === '') return undefined;
    if (hasControl(keyPath)) return 'The key path has a control character in it.';
    if (!keyPath.startsWith('/') && !keyPath.startsWith('~/'))
      return 'Give the key as an absolute path or one under ~/.';
    return undefined;
  }
  if (form.method === 'https') {
    const host = form.host.trim().toLowerCase();
    if (!HOST_PATTERN.test(host)) return 'The host should look like github.com, with an optional :port.';
    if (form.username.trim() === '') return 'A username is required.';
    if (hasControl(form.username) || hasControl(form.token))
      return 'Remove the control character from the username or token.';
    if (form.token === '' && !keepsToken(form, saved)) {
      return saved.https?.hasToken === true
        ? 'The host changed, so enter the token for the new host.'
        : 'A token is required.';
    }
  }
  return undefined;
}

/** What a save sends. The token goes only when the reader typed one. */
export function saveRequestOf(form: GitAuthFormState): GitAuthSaveRequest {
  if (form.method === 'ssh') {
    const keyPath = form.keyPath.trim();
    return keyPath === '' ? { method: 'ssh' } : { method: 'ssh', keyPath };
  }
  if (form.method === 'https') {
    return {
      method: 'https',
      host: form.host.trim().toLowerCase(),
      username: form.username.trim(),
      ...(form.token === '' ? {} : { token: form.token }),
    };
  }
  return { method: 'none' };
}
