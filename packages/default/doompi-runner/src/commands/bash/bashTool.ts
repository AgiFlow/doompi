import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BASH_TOOL_LABEL, BASH_TOOL_NAME, type BashParams, BashParamsSchema } from '../../schemas/bashTool.ts';
import { stripAnsi } from '../../services/AnsiScrub/ansiScrub';
import type { BashRunResult, CompletedRun, IBashRunService } from '../../types/bashRunService';
import { renderBashCall, renderBashResult } from '../../tui/bashRender.ts';
import {
  getBackgroundThresholdMs,
  getResultMaxBytes,
  getResultMaxLines,
  getResultMaxTokens,
  getSuccessResultMaxBytes,
  getSuccessResultMaxTokens,
} from '../../types/config.ts';
import {
  boundExcerpt,
  boundResultText,
  composeExcerpt,
  parseResultPragma,
  type ResultBudget,
  countLines,
  formatSize,
  summarizeLog,
  type ToolResult,
  textResult,
} from './responseEnvelope.ts';

const MS_PER_SECOND = 1000;

const PROMOTION_REASONS: Record<'requested' | 'threshold' | 'interactive', string> = {
  requested: 'Started in the background',
  threshold: 'Still running after the background threshold',
  interactive: 'Started interactively',
};

export const BASH_PROMPT_SNIPPET =
  'Execute shell commands with bounded foreground output and supervised background runners';

/** Written at registration time so the stated threshold matches the configured one. */
export function bashPromptGuidelines(thresholdMs = getBackgroundThresholdMs()): string[] {
  return [
    `A command still running after ${Math.round(thresholdMs / MS_PER_SECOND)} seconds remains active as a background runner with an id and streaming log path.`,
    'Pass background: true only for commands you know will remain active, such as dev servers, watchers, and tails.',
    'Pass interactive: true only when the command will prompt for input. Use Runner Space for terminal input; avoid interactive mode otherwise because its logs are noisier.',
    'On failure, use the returned output first. Inspect the saved log only when the result says output was truncated or no useful output was returned. Never retry an unchanged command merely to recover output.',
    'Stop background runners when they are no longer needed. Every runner is stopped automatically when the session ends.',
  ];
}

export interface BashToolDependencies {
  bashRunService: IBashRunService;
  getSessionId(): string | Promise<string>;
  /** Called after a runner is promoted, so UI state can refresh. */
  onRunnerStarted(id: string): void;
}

/**
 * Registers a tool named `bash`, replacing pi's built-in.
 *
 * The name is deliberate: hooks, guardrails and doom-pi's dispatcher all key on
 * `bash`, and they keep working only while the replacement keeps the name.
 */
export function registerBashTool(pi: ExtensionAPI, dependencies: BashToolDependencies): void {
  pi.registerTool({
    name: BASH_TOOL_NAME,
    label: BASH_TOOL_LABEL,
    description:
      'Execute one Bash command in the current working directory. Foreground commands return bounded output; commands that outlive the threshold return a supervised runner id and streaming log path. Do not rerun a command merely to recover output; inspect the saved log only when the result identifies missing context.',
    promptSnippet: BASH_PROMPT_SNIPPET,
    promptGuidelines: bashPromptGuidelines(),
    parameters: BashParamsSchema,
    // Bash output already carries its own status glyphs and ANSI colours. Owning
    // the shell keeps Pi from filling every successful command with the global
    // toolSuccessBg, which overwhelms long logs and diffs.
    renderShell: 'self',

    async execute(_toolCallId, params, _signal, onUpdate, _ctx): Promise<ToolResult> {
      const { command, timeout, background, interactive, name } = params as BashParams;
      let onOutput: ((output: string) => void) | undefined;
      if (onUpdate) {
        const mode =
          interactive === true ? 'interactive runner' : background === true ? 'background runner' : 'command';
        onUpdate(textResult(`Starting ${mode}...`));
      }
      if (background !== true && interactive !== true && onUpdate) {
        onOutput = (output) => onUpdate(textResult(output));
      }
      let result: BashRunResult;
      try {
        result = await dependencies.bashRunService.run({
          command,
          timeoutMs: timeout === undefined ? undefined : timeout * MS_PER_SECOND,
          background,
          interactive,
          name,
          ...(onOutput ? { onOutput } : {}),
          sessionId: await dependencies.getSessionId(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          [
            `Could not execute command: ${message}`,
            'Next: verify the command, runtime, and working directory. Retry only after correcting the cause.',
          ].join('\n'),
          { cause: error },
        );
      }

      if (result.kind === 'promoted') dependencies.onRunnerStarted(result.id);
      return formatRunResult(result, parseResultPragma(params.command));
    },

    // Without these, pi falls back to echoing the raw command and the tail end of
    // the result text, which is the metadata footer rather than the log output.
    renderCall(args, theme, _context) {
      return renderBashCall(args as BashParams, theme);
    },

    renderResult(result, options, theme, context) {
      return renderBashResult(result, { ...options, isError: context.isError }, theme);
    },
  });
}

function completionFailed(result: CompletedRun): boolean {
  return result.timedOut === true || result.signal !== null || (result.exitCode !== null && result.exitCode !== 0);
}

function completionStatus(result: CompletedRun): string | undefined {
  if (result.timedOut === true) return 'Timed out: exceeded the requested timeout.';
  if (result.signal !== null) return `Signal: ${result.signal}`;
  if (result.exitCode === null) return 'Exit status unavailable.';
  if (result.exitCode !== 0) return `Exit: ${result.exitCode}`;
  return undefined;
}

export function formatRunResult(result: BashRunResult, budget: ResultBudget = {}): ToolResult {
  if (result.kind === 'failed') {
    throw new Error(
      [
        `Could not start runner "${result.name}": ${result.error}`,
        'Next: correct the reported launch or supervision problem. Retry only after changing the command or environment.',
      ].join('\n'),
    );
  }

  if (result.kind === 'promoted') {
    const reason = PROMOTION_REASONS[result.reason];
    const body = [
      `${reason}: runner "${result.name}" (${result.id}).`,
      `Streaming log: ${result.logPath}`,
      `Inspect: doom-runner logs ${result.id}`,
    ].join('\n');

    return textResult(body, {
      id: result.id,
      runner: result.name,
      pid: result.pid,
      logPath: result.logPath,
      promoted: true,
      reason: result.reason,
    });
  }

  // Same shape either way; a success just buys less of it. Exiting 0 has already
  // reported the outcome, so its output is worth a fraction of a failure's.
  const succeeded = !completionFailed(result);
  const maxLines = budget.maxLines ?? getResultMaxLines();
  // An explicit pragma still wins: asking for a wider result is the point of it.
  const maxBytes = budget.maxBytes ?? (succeeded ? getSuccessResultMaxBytes() : getResultMaxBytes());
  const maxTokens = budget.maxTokens ?? (succeeded ? getSuccessResultMaxTokens() : getResultMaxTokens());
  const log = summarizeLog(result.logPath, maxLines, maxBytes, maxTokens);
  const useCapturedOutput = !result.rtkOutput && log.tail.length === 0 && result.output.length > 0;
  let tail: string;
  let tailLines: number;
  let outputLines: number;
  let outputBytes: number;
  let truncated: boolean;
  if (result.rtkOutput) {
    const clipped = Buffer.byteLength(result.rtkOutput.output, 'utf8') < result.rtkOutput.bytes;
    const bounded = clipped
      ? composeExcerpt(
          result.rtkOutput.head,
          result.rtkOutput.output,
          result.rtkOutput.lines,
          maxLines,
          maxBytes,
          [],
          maxTokens,
        )
      : boundExcerpt(result.rtkOutput.output, maxLines, maxBytes, maxTokens);
    tail = bounded.text;
    tailLines = bounded.lines;
    outputLines = result.rtkOutput.lines;
    outputBytes = result.rtkOutput.bytes;
    truncated = outputLines > tailLines || outputBytes > Buffer.byteLength(tail, 'utf8');
  } else {
    tail = useCapturedOutput ? result.output : log.tail;
    tailLines = useCapturedOutput ? countLines(tail) : log.tailLines;
    outputLines = Math.max(log.lines, tailLines);
    outputBytes = useCapturedOutput ? Buffer.byteLength(tail, 'utf8') : log.bytes;
    truncated = !useCapturedOutput && (outputLines > tailLines || outputBytes > Buffer.byteLength(tail, 'utf8'));
  }
  const plainTail = stripAnsi(tail).replace(/\r?\n$/, '');
  const failed = completionFailed(result);
  const status = completionStatus(result);
  const textLines: string[] = [];

  if (plainTail.length === 0) {
    textLines.push(status === undefined ? 'Completed with no output.' : 'No output.');
  } else if (truncated) {
    const label = result.rtkOutput ? `RTK ${result.rtkOutput.filter} excerpt` : 'Log excerpt';
    textLines.push(
      `${label} (${tailLines.toLocaleString('en-US')} of ${outputLines.toLocaleString('en-US')} lines):\n${plainTail}`,
    );
  } else {
    textLines.push(plainTail);
  }
  if (status !== undefined) textLines.push(status);
  if (result.rtkWarning) textLines.push(result.rtkWarning);

  if (truncated) {
    const label = result.rtkOutput ? 'Complete raw log' : 'Full log';
    textLines.push(
      `${label}: ${result.logPath} (${formatSize(log.bytes)}, ${log.lines.toLocaleString('en-US')} lines); inspect with doom-runner logs ${result.id}`,
    );
  } else if (failed && plainTail.length === 0) {
    textLines.push(
      `Log: ${result.logPath}`,
      'Next: run one read-only diagnostic; retry only after correcting the cause.',
    );
  }

  const text = boundResultText(textLines.join('\n'), maxBytes);
  const details = {
    id: result.id,
    runner: result.name,
    exitCode: result.exitCode,
    logPath: result.logPath,
    backend: result.backend,
    fileSize: log.bytes,
    lines: useCapturedOutput ? tailLines : log.lines,
    tail,
    tailLines,
    ...(result.rtkOutput
      ? {
          rtkFilter: result.rtkOutput.filter,
          rtkOutputBytes: result.rtkOutput.bytes,
          rtkOutputLines: result.rtkOutput.lines,
        }
      : {}),
    ...(result.rtkWarning ? { rtkWarning: result.rtkWarning } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
  };

  if (failed) throw new Error(text);
  return textResult(text, details);
}
