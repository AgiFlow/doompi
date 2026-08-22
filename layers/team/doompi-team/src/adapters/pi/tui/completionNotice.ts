/**
 * Renders the `subagent-notify` custom message: what the parent session
 * actually SEES when a background run finishes. `CompletionNotifier` produces
 * the message (`runs/background/notify.ts`); this decides how it looks.
 *
 * WHY THERE IS NO CONTENT PARSER HERE:
 * The predecessor rendered from `message.details` when present and otherwise
 * re-derived the details by running a regex back over its own formatted
 * markdown (`parseSubagentNotifyContent`). That fallback existed because its
 * notifier sent no `details` at all for grouped completions, so the renderer
 * had a real case where re-parsing was the only source. This package sends
 * `details` on EVERY message, single and grouped alike (see
 * `CompletionNotifier.emit`), so the parser has no case left to serve and is
 * deliberately not ported: a regex that has to stay in lockstep with a
 * formatter living in another domain is a standing correctness liability, and
 * the one thing it protected against is now structurally impossible.
 *
 * The plain-text fallback below is NOT that parser. It covers a genuinely
 * different case: a message with no `details`, which can only reach a reader
 * from a persisted transcript written before this field existed. Showing its
 * raw content verbatim is correct there - it is exactly what the old renderer
 * did when its parse returned undefined.
 *
 * DESIGN PATTERNS:
 * - `options.expanded` gates preview lines the same way `fleetTranscript.ts`
 *   gates its own body: collapsed shows the first non-empty line, expanded
 *   shows all of them. A completion preview is frequently a multi-paragraph
 *   summary, and unconditionally printing it would push the rest of the
 *   session's scrollback away on every finished run
 */

import type { ExtensionAPI, MessageRenderOptions, Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import { type CompletionNotifyDetails, SUBAGENT_NOTIFY_MESSAGE_TYPE } from '../../runs/background/notify';
import { formatDuration } from './formatters';

/** Status glyphs. Paused is distinct from failed: the run can still be resumed. */
function statusIcon(status: CompletionNotifyDetails['status'], theme: Theme): string {
  if (status === 'completed') return theme.fg('success', '✓');
  if (status === 'paused') return theme.fg('warning', '■');
  return theme.fg('error', '✗');
}

function previewLines(resultPreview: string, expanded: boolean): string[] {
  const trimmed = resultPreview.trim();
  const lines = expanded ? trimmed.split('\n') : [trimmed.split('\n', 1)[0] ?? ''];
  const kept = lines.filter((line) => line.trim());
  return kept.length > 0 ? kept : ['(no output)'];
}

/** One completion's block: header line, then its indented preview and metadata. */
function renderDetail(detail: CompletionNotifyDetails, expanded: boolean, theme: Theme): string {
  const meta: string[] = [];
  if (detail.taskInfo) meta.push(detail.taskInfo);
  if (detail.durationMs !== undefined) meta.push(formatDuration(detail.durationMs));

  const separator = ` ${theme.fg('dim', '·')} `;
  let text = `${statusIcon(detail.status, theme)} ${theme.bold(detail.agent)} ${theme.fg('dim', detail.status)}`;
  if (meta.length > 0) text += `${separator}${meta.map((part) => theme.fg('dim', part)).join(separator)}`;
  // The run id is what every follow-up command takes, so it belongs on the
  // collapsed line too - not only in the expanded body a reader has to open.
  if (detail.runId) text += `${separator}${theme.fg('dim', detail.runId)}`;

  for (const line of previewLines(detail.resultPreview, expanded)) {
    text += `\n  ${theme.fg('dim', `⎿  ${line}`)}`;
  }
  if (detail.handoffPath) text += `\n  ${theme.fg('muted', `Parallel handoff: ${detail.handoffPath}`)}`;
  if (detail.sessionLabel && detail.sessionValue) {
    text += `\n  ${theme.fg('muted', `${detail.sessionLabel}: ${detail.sessionValue}`)}`;
  }
  return text;
}

/**
 * Exported for tests: the rendered string, before it is wrapped in a `Text`
 * component. Kept separate so the formatting is assertable without standing up
 * a TUI - the same split `fleetTranscript.ts` uses for `renderFleetTranscript`.
 */
export function renderCompletionNotice(
  details: CompletionNotifyDetails[],
  options: { expanded: boolean },
  theme: Theme,
): string {
  if (details.length === 1) return renderDetail(details[0]!, options.expanded, theme);
  const header = theme.bold(`Background tasks completed (${details.length})`);
  // Collapsed multi-run notices stay one line per run: a fan-out of ten
  // children would otherwise emit thirty-plus lines in one go.
  return [header, ...details.map((detail) => renderDetail(detail, options.expanded, theme))].join('\n');
}

function asDetails(value: unknown): CompletionNotifyDetails[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const isDetail = (entry: unknown): entry is CompletionNotifyDetails =>
    typeof entry === 'object' && entry !== null && typeof (entry as CompletionNotifyDetails).agent === 'string';
  return value.every(isDetail) ? value : undefined;
}

export function registerCompletionRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<CompletionNotifyDetails[]>(
    SUBAGENT_NOTIFY_MESSAGE_TYPE,
    (message, options: MessageRenderOptions, theme: Theme): Component => {
      const content = typeof message.content === 'string' ? message.content : '';
      const details = asDetails(message.details);
      // See the module header: no details means a pre-field transcript entry,
      // not a message to re-derive by parsing.
      if (!details) return new Text(content, 0, 0);
      return new Text(renderCompletionNotice(details, { expanded: options.expanded === true }, theme), 0, 0);
    },
  );
}
