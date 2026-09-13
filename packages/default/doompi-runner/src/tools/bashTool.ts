import { definePiTool, type PiToolDeclaration } from '@agimon-ai/doompi-core/pi-extension';

import { BASH_TOOL_LABEL, BASH_TOOL_NAME, MS_PER_SECOND } from '../constants/bashTool';
import { type BashParams, BashParamsSchema } from '../schemas/bashTool';
import { formatRunResult, parseResultPragma, textResult } from '../services/bashResult';
import { getBackgroundThresholdMs } from '../services/runnerConfig';
import { type ToolResult } from '../types/bashResult';
import type { BashRunResult } from '../types/bashRunService';
import type { BashToolDependencies, BashToolRenderers } from '../types/bashTool';

export const BASH_PROMPT_SNIPPET =
  'Execute shell commands with bounded foreground output and supervised background runners';

/** Written at registration time so the stated threshold matches the configured one. */
export function bashPromptGuidelines(thresholdMs = getBackgroundThresholdMs()): string[] {
  return [
    `A command still running after ${Math.round(thresholdMs / MS_PER_SECOND)} seconds remains active as a background runner with an id and streaming log path. You are messaged automatically when it exits, so never sleep, poll, or pgrep to wait for one.`,
    'Pass background: true only for commands you know will remain active, such as dev servers, watchers, and tails.',
    'Pass interactive: true only when the command will prompt for input. Use Runner Space for terminal input; avoid interactive mode otherwise because its logs are noisier.',
    'Results are already bounded and the full log is saved to disk. Do not pipe to head or tail: it adds nothing and leaves the live log empty while the command runs.',
    'On failure, use the returned output first. Inspect the saved log only when the result says output was truncated or no useful output was returned. Never retry an unchanged command merely to recover output.',
    'Stop background runners when they are no longer needed. Every runner is stopped automatically when the session ends.',
  ];
}

/**
 * Registers a tool named `bash`, replacing pi's built-in.
 *
 * The name is deliberate: hooks, guardrails and doom-pi's dispatcher all key on
 * `bash`, and they keep working only while the replacement keeps the name.
 */
export function createBashTool(
  dependencies: BashToolDependencies,
  renderers: BashToolRenderers = {},
): PiToolDeclaration {
  return definePiTool({
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
      return formatRunResult(result, parseResultPragma(params.command), dependencies.summarizeLog);
    },

    ...renderers,
  });
}
