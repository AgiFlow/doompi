import path from 'node:path';
import type { DesktopNotification } from '../types/notifications.ts';

const ATTENTION_SUBTITLE = 'Approval or feedback required';
const ATTENTION_TITLE = 'Pi needs your input';
const ELLIPSIS = '…';
const MAX_BODY_LENGTH = 240;
const MAX_PROMPT_TITLE_LENGTH = 36;
const SETTLED_BODY = 'The agent finished its work and is waiting for you.';
const SETTLED_TITLE = 'Pi finished';
const SHELL_TITLE_SEPARATOR = ' - ';
const SHELL_TITLE_PREFIX = 'π';

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}${ELLIPSIS}` : value;
}

/** The first user prompt, shortened to fit a shell tab. A blank prompt names nothing. */
export function promptTitle(prompt: string): string | undefined {
  const normalized = collapseWhitespace(prompt);
  return normalized ? truncate(normalized, MAX_PROMPT_TITLE_LENGTH) : undefined;
}

export interface ShellTabTitleInput {
  cwd: string;
  sessionName?: string;
  prompt?: string;
}

/**
 * The idle shell-tab title: `π - <label> - <repository>`.
 *
 * The session name wins over the first prompt because the user chose it. With
 * neither, the repository alone still tells two tabs apart.
 */
export function shellTabTitle({ cwd, sessionName, prompt }: ShellTabTitleInput): string {
  const repository = path.basename(cwd);
  const label = sessionName ?? prompt;
  return label
    ? `${SHELL_TITLE_PREFIX}${SHELL_TITLE_SEPARATOR}${label}${SHELL_TITLE_SEPARATOR}${repository}`
    : `${SHELL_TITLE_PREFIX}${SHELL_TITLE_SEPARATOR}${repository}`;
}

/** Notification bodies are one line in a system panel, so they collapse and truncate. */
export function notificationBody(body: string): string {
  return truncate(collapseWhitespace(body), MAX_BODY_LENGTH);
}

/** Sent while the agent holds the turn and something is blocking on the user. */
export function attentionNotification(body: string): DesktopNotification {
  return { title: ATTENTION_TITLE, subtitle: ATTENTION_SUBTITLE, body };
}

/** Sent once a run has stopped, subtitled with whichever name the user recognises. */
export function settledNotification({ cwd, sessionName }: { cwd: string; sessionName?: string }): DesktopNotification {
  return { title: SETTLED_TITLE, subtitle: sessionName ?? path.basename(cwd), body: SETTLED_BODY };
}
