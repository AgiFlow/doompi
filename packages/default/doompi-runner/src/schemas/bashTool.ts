import { type Static, Type } from 'typebox';

/** Replaces pi's built-in tool of the same name, so hooks keyed on `bash` keep working. */
export const BASH_TOOL_NAME = 'bash';
export const BASH_TOOL_LABEL = 'bash';

/** Floor for `alarm`, so a short interval cannot flood the conversation. */
export const MIN_ALARM_SECONDS = 10;

/**
 * Built-in bash parameters plus the backgrounding controls.
 *
 * `command` and `timeout` keep their original names and wording so the tool is
 * a drop-in replacement. Every `description` is prompt copy the model reads.
 */
export const BashParamsSchema = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
  background: Type.Optional(
    Type.Boolean({
      description:
        'Start the command in the background immediately instead of waiting. Use for dev servers, watchers and other commands you already know will not finish.',
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        'Run under a pseudo terminal so the command can prompt. Use only when the command asks for confirmation or input; answer it with doom-runner input. Logs from interactive runs are noisier.',
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: 'Preferred runner name if the command ends up in the background. A name in use gets a suffix.',
    }),
  ),
  alarm: Type.Optional(
    Type.Number({
      description: `Send you a snapshot of this runner every N seconds, so you never have to poll it. Implies background. Use it to watch a dev server or a long build, or to wake yourself on a schedule by backgrounding a sleep loop. Minimum ${MIN_ALARM_SECONDS} seconds. It stops on its own when the process exits, or early with doom-runner alarm stop <id>.`,
    }),
  ),
});

export type BashParams = Static<typeof BashParamsSchema>;
