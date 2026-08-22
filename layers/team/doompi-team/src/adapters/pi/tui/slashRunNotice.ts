/**
 * Renders the `subagent-slash-result` custom message: what a slash launch
 * (`/run`, `/parallel`) and the agent catalog's launch keys put in the parent
 * session's scrollback. `slashCommands.ts` produces the message; this decides
 * how it looks.
 *
 * WHY A SECOND RENDERER RATHER THAN REUSING `completionNotice.ts`:
 * That one renders a background run's TERMINAL result and is built around
 * `CompletionNotifyDetails` - a result preview, a duration, a handoff path.
 * A launch notice reports a run's transition (started, then whatever it
 * settled as) and carries none of that. Sharing one renderer would mean one
 * details shape carrying two sets of mostly-absent fields.
 *
 * DESIGN PATTERNS:
 * - Same fallback contract as `completionNotice.ts`: a message with no
 *   `details` renders its raw content verbatim, which is the only correct
 *   answer for a plain-text report (`/subagents-doctor`) or a transcript
 *   entry written before the field existed
 * - One line per run. A `/parallel` fan-out of ten children must not emit
 *   thirty lines into the scrollback
 */

import type { ExtensionAPI, MessageRenderOptions, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import { SLASH_RESULT_CUSTOM_TYPE, type SlashRunDetail } from '../commands/slash/slashCommands';

/** How much of a run id a line carries. `RunIdResolver` takes a prefix, so this stays usable, not decorative. */
const RUN_ID_PREFIX_LENGTH = 8;
const STARTED_STATUSES = new Set(['started', 'queued', 'pending']);
const COMPLETED_STATUSES = new Set(['complete', 'completed']);
const HELD_STATUSES = new Set(['paused', 'stopped']);

function statusIcon(status: string, theme: Theme): string {
  if (STARTED_STATUSES.has(status)) return theme.fg('accent', '▶');
  if (COMPLETED_STATUSES.has(status)) return theme.fg('success', '✓');
  // Held is distinct from failed: the run stopped short but did not go wrong.
  if (HELD_STATUSES.has(status)) return theme.fg('warning', '■');
  return theme.fg('error', '✗');
}

function detailLine(detail: SlashRunDetail, theme: Theme): string {
  const separator = ` ${theme.fg('dim', '·')} `;
  const parts = [theme.fg('dim', detail.status)];
  if (detail.runId) parts.push(theme.fg('dim', detail.runId.slice(0, RUN_ID_PREFIX_LENGTH)));
  let text = `${statusIcon(detail.status, theme)} ${theme.bold(detail.agent)}${separator}${parts.join(separator)}`;
  if (detail.warning) text += `\n  ${theme.fg('warning', `⎿  ${detail.warning}`)}`;
  if (detail.error) text += `\n  ${theme.fg('dim', `⎿  ${detail.error}`)}`;
  return text;
}

/**
 * Exported for tests: the rendered string, before it is wrapped in a `Text`
 * component, so the formatting is assertable without standing up a TUI - the
 * same split `completionNotice.ts` uses.
 */
export function renderSlashRunNotice(details: readonly SlashRunDetail[], theme: Theme): string {
  return details.map((detail) => detailLine(detail, theme)).join('\n');
}

function asDetails(value: unknown): SlashRunDetail[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const isDetail = (entry: unknown): entry is SlashRunDetail =>
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as SlashRunDetail).agent === 'string' &&
    typeof (entry as SlashRunDetail).status === 'string';
  return value.every(isDetail) ? value : undefined;
}

export function registerSlashRunRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<SlashRunDetail[]>(
    SLASH_RESULT_CUSTOM_TYPE,
    (message, _options: MessageRenderOptions, theme: Theme): Component => {
      const content = typeof message.content === 'string' ? message.content : '';
      const details = asDetails(message.details);
      // See the module header: no details means a plain-text report or a
      // pre-field transcript entry, both correct to show verbatim.
      if (!details) return new Text(content, 0, 0);
      return new Text(renderSlashRunNotice(details, theme), 0, 0);
    },
  );
}
