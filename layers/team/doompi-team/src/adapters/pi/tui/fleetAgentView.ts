/**
 * The fleet detail pane's `agent` tab: what a run was configured with, and the
 * system prompt it was actually launched with.
 *
 * WHY A TAB RATHER THAN MORE HEADER:
 * The transcript answers "what has this run done"; this answers "what was it
 * told to do". The second question is asked far less often than the first but
 * needs far more room when it is, so the two share the pane by swapping rather
 * than by competing for the same fixed rows.
 *
 * WHERE THE PROMPT COMES FROM:
 * `asyncExecution.ts` records it to a sidecar at spawn (see
 * `SYSTEM_PROMPT_FILE_NAME`), because the launch config that carried it is
 * deleted as soon as the child handshakes and the agent definition on disk can
 * change while a run is still going. Re-resolving the agent by name here would
 * therefore show what the NEXT run would get, not what this one did. Runs that
 * predate the sidecar, and inline agents, fall back in `readAgentSystemPrompt`;
 * when neither has it the pane says so rather than showing a plausible guess.
 *
 * DESIGN PATTERNS:
 * - Reading is the caller's business: `readAgentSystemPrompt` is separate from
 *   rendering so the overlay can cache the file read on a content fingerprint,
 *   the same discipline `fleet.ts` applies to transcripts
 */

import * as fs from 'node:fs';
import { Markdown, type MarkdownTheme, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

import type { AsyncRunStatus } from '../../runs/background/asyncExecution';
import { formatDuration, formatModelThinking } from './formatters';
import type { FleetTranscriptTheme } from './fleetTranscript';

export const FIELD_LABEL_WIDTH = 8;
const FIELD_FALLBACK = '—';

/** A dim fixed-width label with its value, shared by both detail tabs. */
export function fieldRow(label: string, value: string, width: number, theme: FleetTranscriptTheme): string {
  return truncateToWidth(`  ${theme.fg('dim', label.padEnd(FIELD_LABEL_WIDTH))}${value}`, width);
}

export type AgentSystemPromptSource = 'run' | 'inline' | 'none';

export interface AgentSystemPrompt {
  text?: string;
  /** Which fallback supplied the text, so the pane can say how sure it is. */
  source: AgentSystemPromptSource;
  warning?: string;
}

/**
 * Resolve a run's system prompt from what was recorded for it.
 *
 * Never throws: a missing sidecar is the normal state for a run started before
 * it was written, and for every non-`pi` runtime.
 */
export function readAgentSystemPrompt(status: AsyncRunStatus | undefined): AgentSystemPrompt {
  if (!status) return { source: 'none' };
  if (status.systemPromptPath) {
    try {
      return { text: fs.readFileSync(status.systemPromptPath, 'utf-8'), source: 'run' };
    } catch (cause) {
      return { source: 'none', warning: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  const inline = status.inlineAgent?.systemPrompt;
  if (inline) return { text: inline, source: 'inline' };
  return { source: 'none' };
}

/** A stable fingerprint of the prompt source, for the overlay's read cache. */
export function agentSystemPromptFingerprint(status: AsyncRunStatus | undefined): string {
  if (!status) return 'none';
  if (status.systemPromptPath) {
    try {
      const stat = fs.statSync(status.systemPromptPath);
      return `${status.systemPromptPath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${status.systemPromptPath}:missing`;
    }
  }
  return status.inlineAgent?.systemPrompt ? `inline:${status.inlineAgent.systemPrompt.length}` : 'none';
}

function toolsSummary(status: AsyncRunStatus): string {
  if (status.noTools) return 'none (tools disabled)';
  const allowed = status.tools?.length ? status.tools.join(', ') : undefined;
  const excluded = status.excludeTools?.length ? `excluding ${status.excludeTools.join(', ')}` : undefined;
  return [allowed ?? 'inherited defaults', excluded].filter(Boolean).join(' · ');
}

function sourceNote(prompt: AgentSystemPrompt): string {
  if (prompt.source === 'run') return 'recorded at spawn';
  if (prompt.source === 'inline') return 'inline agent definition';
  return 'not recorded';
}

export interface AgentViewInput {
  status: AsyncRunStatus | undefined;
  /** Roster state, which stays authoritative even when no status file was found. */
  state: string;
  agent: string;
  runId: string;
  prompt: AgentSystemPrompt;
  width: number;
  theme: FleetTranscriptTheme;
  markdownTheme?: MarkdownTheme;
  now?: number;
}

/** The agent tab body. Scrolled by the caller, so this returns every line it has. */
export function renderAgentView(input: AgentViewInput): string[] {
  const { status, width, theme, prompt } = input;
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];

  lines.push(fieldRow('Run', input.runId, safeWidth, theme));
  lines.push(fieldRow('Agent', status?.agent ?? input.agent, safeWidth, theme));
  lines.push(fieldRow('State', input.state, safeWidth, theme));
  lines.push(fieldRow('Model', status?.model ? formatModelThinking(status.model) : FIELD_FALLBACK, safeWidth, theme));
  lines.push(fieldRow('Runtime', status?.runtime ?? 'pi', safeWidth, theme));
  lines.push(fieldRow('Cwd', status?.cwd ?? FIELD_FALLBACK, safeWidth, theme));
  lines.push(fieldRow('Tools', status ? toolsSummary(status) : FIELD_FALLBACK, safeWidth, theme));
  if (status?.startedAt !== undefined) {
    const elapsed = formatDuration((status.endedAt ?? input.now ?? Date.now()) - status.startedAt);
    lines.push(fieldRow('Started', `${new Date(status.startedAt).toISOString()} · ${elapsed}`, safeWidth, theme));
  }

  if (status?.task) {
    lines.push('', truncateToWidth(`  ${theme.fg('accent', theme.bold('TASK'))}`, safeWidth));
    for (const line of wrapTextWithAnsi(status.task, safeWidth)) lines.push(line);
  }

  lines.push(
    '',
    truncateToWidth(
      `  ${theme.fg('accent', theme.bold('SYSTEM PROMPT'))} ${theme.fg('dim', `· ${sourceNote(prompt)}`)}`,
      safeWidth,
    ),
  );
  if (prompt.text) {
    const body = input.markdownTheme
      ? new Markdown(prompt.text, 0, 0, input.markdownTheme).render(safeWidth)
      : wrapTextWithAnsi(prompt.text, safeWidth);
    lines.push(...body);
  } else {
    const reason = prompt.warning
      ? `The recorded system prompt could not be read: ${prompt.warning}`
      : status?.runtime && status.runtime !== 'pi'
        ? `This run uses the '${status.runtime}' runtime, which is launched as an external CLI and has no recorded system prompt.`
        : 'No system prompt was recorded for this run. Runs started before the prompt sidecar existed do not have one.';
    for (const line of wrapTextWithAnsi(reason, safeWidth)) lines.push(theme.fg('muted', line));
  }
  return lines;
}
