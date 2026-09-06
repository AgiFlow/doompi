# Author computer scripts

`computer_exec` runs reusable local TypeScript against the application that the current Desktop grant authorized. Scripts are trusted Node.js programs. They are not sandboxed and can use the full permissions of the Pi process. Only allow scripts you have reviewed.

## Allow a script

Set `DOOMPI_COMPUTER_USE_SCRIPT_PATHS` before starting Pi. Its value is a platform-delimited list of exact script paths (`:` on macOS and Linux). Symlinks are resolved before the exact-path check.

```bash
export DOOMPI_COMPUTER_USE_SCRIPT_PATHS="$PWD/scripts/fill-form.ts:$PWD/scripts/read-summary.ts"
```

The tool does not accept a directory, glob, inline source, or a path that was not listed. Scripts must use the `.ts` extension.

## Script contract

Export a named `run` function. It receives only the active authorized program handle in `context.program`, JSON input, a bounded logger, and an abort signal:

```ts
import type { ComputerScriptRun } from '@agimon-ai/doompi-computer-use';

export const run: ComputerScriptRun = async ({ context: { program }, input, logger, signal }) => {
  if (signal.aborted) throw signal.reason;

  const options = input as { snapshotId: string; elementRef: string };
  logger.info('Pressing the requested element');
  return program.act({
    kind: 'press',
    snapshotId: options.snapshotId,
    elementRef: options.elementRef,
  });
};
```

`program.observe()` returns a semantic observation. `program.act(action)` applies one semantic action. Calls are serialized through the existing session API. A successful run keeps the session active and `computer_exec` returns a fresh observation for the next turn.

Scripts are loaded with Node.js type stripping. Use erasable TypeScript syntax. The runner enforces a 30 second execution timeout and a combined 256 KiB bound for input, logs, process output, and the serialized result. Cancellation or a limit breach terminates the worker process. A cancelled in-flight Desktop request can make the session stop because its outcome is uncertain.
