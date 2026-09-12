import type {
  DoomHeadlessCommand,
  DoomHeadlessExecutionContext,
  DoomHeadlessTool,
  DoomHeadlessToolResult,
} from '@agimon-ai/doompi-core/headless';
import { BASH_TOOL_LABEL, BASH_TOOL_NAME } from '../constants/bashTool';
import { MS_PER_SECOND } from '../constants/headless';
import { COMMAND_NAME, SERVER_COMMAND_DESCRIPTION } from '../constants/runners';
import { type BashParams, BashParamsSchema } from '../schemas/bashTool';
import { formatRunResult, parseResultPragma, textResult } from '../services/bashResult';
import { stopRunnerProcess } from '../services/reconcile';
import { getBackgroundThresholdMs } from '../services/runnerConfig';
import type { RunnerDependencies } from '../services/runnerDependencies/type';
import { parseRunnersCommand } from '../services/runnersCommand';
import { type LogSummarizer } from '../types/bashResult';
import type { IBashRunService } from '../types/bashRunService';

export function createHeadlessBashTool(
  bashRunService: IBashRunService,
  summarizeLog?: LogSummarizer,
): DoomHeadlessTool<typeof BashParamsSchema> {
  return {
    name: BASH_TOOL_NAME,
    label: BASH_TOOL_LABEL,
    description:
      'Execute one Bash command in the current working directory. Foreground commands return bounded output; commands that outlive the threshold return a supervised runner id and streaming log path.',
    promptSnippet: 'Execute shell commands with bounded foreground output and supervised background runners',
    promptGuidelines: [
      `A command still running after ${Math.round(getBackgroundThresholdMs() / MS_PER_SECOND)} seconds remains active as a background runner with an id and streaming log path.`,
      'Pass background: true for commands that should remain active, such as dev servers, watchers, and tails.',
      'Stop background runners when they are no longer needed.',
    ],
    parameters: BashParamsSchema,
    executionMode: 'serial',
    execute: async (
      _toolCallId: string,
      params: BashParams,
      signal: AbortSignal | undefined,
      onUpdate: ((result: DoomHeadlessToolResult) => void) | undefined,
      context: DoomHeadlessExecutionContext,
    ) => {
      const { command, timeout, background, interactive, name } = params;
      if (signal?.aborted) throw new Error('Operation aborted');
      if (onUpdate)
        onUpdate(
          textResult(
            `Starting ${interactive === true ? 'interactive runner' : background === true ? 'background runner' : 'command'}...`,
          ),
        );
      let onOutput: ((output: string) => void) | undefined;
      if (background !== true && interactive !== true && onUpdate) onOutput = (output) => onUpdate(textResult(output));
      const result = await bashRunService.run({
        command,
        timeoutMs: timeout === undefined ? undefined : timeout * MS_PER_SECOND,
        background,
        interactive,
        name,
        ...(onOutput ? { onOutput } : {}),
        cwd: context.cwd,
        sessionId: context.sessionId,
      });
      return formatRunResult(result, parseResultPragma(command), summarizeLog);
    },
  };
}

export function createHeadlessRunnersCommand(dependencies: RunnerDependencies): DoomHeadlessCommand {
  return {
    name: COMMAND_NAME,
    description: SERVER_COMMAND_DESCRIPTION,
    async execute(args: string, context: DoomHeadlessExecutionContext) {
      const request = parseRunnersCommand(args);
      if (request.kind === 'space') {
        const active = await dependencies.runnerRegistry.listBySession(context.sessionId);
        await context.client.notify({
          body: `${active.length} active runner${active.length === 1 ? '' : 's'}.`,
          level: 'info',
        });
        return;
      }
      if (request.kind === 'start') {
        if (!request.command) throw new Error('Usage: /runners start [name=x] [cwd=y] [interactive=true] -- <command>');
        const result = await dependencies.bashRunService.run({
          command: request.command,
          background: true,
          sessionId: context.sessionId,
          cwd: request.cwd === undefined ? context.cwd : request.cwd,
          ...(request.name ? { name: request.name } : {}),
          ...(request.interactive ? { interactive: true } : {}),
        });
        await context.client.notify({
          body: formatRunResult(result).content[0]?.text ?? 'Runner started.',
          level: 'info',
        });
        return;
      }
      if (!request.id) throw new Error('Usage: /runners stop <runner-id> [reason]');
      const record = await dependencies.runnerRegistry.get(request.id, context.sessionId);
      if (!record) {
        await context.client.notify({ body: `No active runner ${request.id} in this session.`, level: 'warning' });
        return;
      }
      const stopped = await stopRunnerProcess(record, dependencies.launcher, dependencies.rmuxBackend);
      if (stopped) {
        await dependencies.runnerRegistry.complete(
          request.id,
          {
            reason: 'stopped',
            code: null,
            signal: null,
            ...(request.reason ? { stopReason: request.reason } : {}),
          },
          context.sessionId,
        );
      }
      await context.client.notify({
        body: stopped ? `Stopped runner ${request.id}.` : `Could not stop runner ${request.id}.`,
        level: stopped ? 'info' : 'error',
      });
    },
  };
}
