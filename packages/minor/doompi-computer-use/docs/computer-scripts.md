# Author computer functions

`computer_exec` runs an ordinary `run` function against the application authorized by the current Desktop grant. Write the function and any helpers using the existing file tools, then call `computer_exec` with `scriptPath` and JSON `input`. A function does not need its own extension package or registered agent tool.

## Restricted execution, the default

The Desktop-backed server admits scripts below the session working directory. Entry files and relative helpers may use `.ts`, `.js`, or `.mjs`. TypeScript must use erasable syntax. The loader resolves real paths and rejects helpers that escape this directory, including through symlinks. Inline source, package imports, and `node:` imports are not supported in restricted execution.

Generated code runs inside a separate QuickJS WebAssembly runtime in a child process. Only the program callbacks, JSON input, bounded logger, and portable cancellation signal are exposed. Node globals, environment variables, filesystem access, networking, subprocesses, and host constructors are not exposed to the function. Relative helpers execute with the same restrictions. This is not permission to control another application: every program operation still passes through the current session's Desktop grant checks.

## Function contract

```ts
import type { ComputerScriptProgram, ComputerScriptRun } from '@agimon-ai/doompi-computer-use';

async function pressByLabel(program: ComputerScriptProgram, label: string) {
  const snapshot = await program.observe();
  const matches = snapshot.elements.filter(
    (element) => element.label === label && element.enabled && !element.secure && element.actions.includes('press'),
  );
  if (matches.length !== 1) throw new Error(`Expected one pressable element named ${label}.`);
  await program.act({
    kind: 'press',
    snapshotId: snapshot.snapshotId,
    elementRef: matches[0]!.ref,
  });
}

export const run: ComputerScriptRun = async ({ context: { program }, input, logger, signal }) => {
  if (typeof input !== 'object' || input === null || !('label' in input) || typeof input.label !== 'string') {
    throw new Error('input.label must be a string.');
  }
  signal.throwIfAborted();
  await pressByLabel(program, input.label);
  logger.info('Pressed the requested element.');
  return { pressed: input.label };
};
```

Type-only imports are erased before execution. Runtime helpers can be moved into neighboring files and imported with explicit relative paths such as `./press.ts`.

`program.observe()` returns current semantic state without a screenshot by default. `program.observe({ includeScreenshot: true })` additionally captures an image. `program.act(action)` supports `press`, `focus`, `set_value`, and `scroll` against current snapshot IDs and element refs. Calls are serialized even when the function starts several promises. Re-observe after changes; serialization does not make old snapshots valid.

Use normal local variables and function arguments for working state within a chain. An observation is a snapshot, not a mutable application instance. Actual application changes must use `program.act`. Each invocation starts a fresh worker; module globals do not persist across invocations.

The portable `signal` supports `aborted` and `throwIfAborted()`. Restricted functions should not assume the rest of the Node AbortSignal or timer APIs exists. An external timeout can terminate synchronous infinite loops as well as pending asynchronous work.

## Tool result and limits

By default, successful `computer_exec` returns the function's JSON result, bounded logs, a fresh semantic observation, and execution metrics. Pass `includeScreenshot: true` to the tool to include a final image. Images use image content blocks, not base64 embedded in model-facing observation text. Avoid returning image data inside the function's own result.

The default execution deadline is 30 seconds. Input and text output are bounded to 256 KiB, with the final semantic observation counted against output. The final tool formatter also checks the complete text response. Images have a separate 6 MiB decoded-size ceiling. Restricted execution limits its JavaScript heap to 32 MiB, stack to 512 KiB, helper graph to 32 modules, individual source files to 256 KiB, total source to 512 KiB, and outstanding program operations to 64.

On failure, `computer_exec` reports completed actions and whether an action's outcome is uncertain when that information is available. Cancellation prevents queued actions from starting and attempts to abort the current request. An interrupted request may already have changed the application, so do not automatically retry the entire chain or repeat the uncertain action. Re-establish authorized, fresh state before continuing.

Metrics describe this invocation's action count, observation count, elapsed milliseconds, and counted text-output bytes. They are not a measurement of model tokens or native application reliability.

## Explicitly trusted Node scripts

Full Node execution remains available only with `trusted: true` and an entry path explicitly included in the host-configured `DOOMPI_COMPUTER_USE_SCRIPT_PATHS`. The value is a platform-delimited list of exact paths, not directories or globs:

```bash
export DOOMPI_COMPUTER_USE_SCRIPT_PATHS="$PWD/scripts/reviewed.ts"
```

Trusted scripts use normal file-based module loading, including relative imports. They are **not sandboxed** and inherit the Pi process environment and permissions. Review the entrypoint and every dependency before allowing them, and protect those files against unreviewed modification. The path allowlist is not a content signature and does not approve subsequent edits or dependency changes. Setting an allowlisted path alone does not switch execution out of restricted mode.

## Desktop ownership

Mode selection, global opt-in, and a native application grant are separate. A selected mode is not authority. Before granting control, the owning Desktop renderer must authorize the request, and the agent must be idle with no queued prompts. The native host then asks for confirmation of the application window and duration.

Once Desktop claims a session for this workflow, browser and remote MCP clients cannot drive that session, including connections attached before the claim. The claim remains pinned for the server lifetime, even after stopping control or losing Desktop, so another client cannot take over a session that handled Desktop capabilities. Grants and claims are not restored from persisted session data.
