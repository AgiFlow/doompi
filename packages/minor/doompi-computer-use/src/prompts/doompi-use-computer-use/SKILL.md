---
name: doompi-use-computer-use
description: 'Use Desktop-authorized semantic computer control and compose restricted application functions.'
---

# Use Computer Use

This guidance applies only while this session holds an active application grant from its owning DoomPi Desktop instance. A selected minor mode is not a grant. Normal browsers and remote MCP clients cannot obtain Desktop authority.

## Observe and act

Call `computer_state` before choosing an action. Use `includeScreenshot: false` for semantic-only inspection when an image is unnecessary. Use only the snapshot IDs and element refs returned by the current observation. `computer_action` supports `press`, `focus`, `set_value`, and `scroll`. Never infer coordinates, inspect another application, or bypass secure elements.

Re-observe after actions that change the interface. Check the expected outcome rather than replaying stale refs or sleeping for a guessed interval. An observation is a snapshot: editing its fields does not mutate the application.

## Compose reusable functions

For predictable multi-step work, write a `.ts`, `.js`, or `.mjs` file below the session working directory using the existing file tools. Export `run({ context: { program }, input, logger, signal })`. Invoke it through `computer_exec` with `scriptPath` and JSON `input`. This batches local actions into one agent tool call; it does not require registering a new tool per function.

The authorized `program` exposes `observe(options?)` and `act(action)`. Keep working state in ordinary variables and pass it to helper functions. Helpers can be imported with explicit relative paths within the working directory. Re-observe inside the chain whenever a previous action may have invalidated a snapshot.

Generated functions run with restricted capabilities, not as Node programs. Do not import `node:` modules, installed packages, network APIs, or host constructors. Type-only imports are erased. Cancellation supports `signal.aborted` and `signal.throwIfAborted()`. Each invocation starts fresh; do not rely on globals persisting.

`program.observe()` and the final `computer_exec` observation omit screenshots by default. Request `includeScreenshot: true` only where an image is needed. Return compact JSON, not screenshot base64 or entire repeated observations. Keep logs small. The default deadline is 30 seconds and bounded text output includes the final semantic observation.

Full Node execution is a separate trusted path. Never request `trusted: true` to evade a restricted-runtime error. It requires an explicitly host-allowlisted entry and reviewed dependencies; those programs are not sandboxed.

## Stop and recover

Failures report completed actions and uncertain outcomes where available. Never automatically retry an uncertain action or replay a partially completed chain. Stop, inspect the failure, and re-establish authorized fresh state before continuing.

Activation requires Desktop's global opt-in, the selected mode, an idle agent without queued prompts, and explicit native confirmation of the target window and duration. Once Desktop claims the session, browser and remote MCP clients cannot drive it for the rest of the server lifetime. Grants are not restored across restarts.

Stop Computer Use when the requested task is complete. Expiry, cancellation, mode disable, global disable, and Desktop disconnection must not be bypassed.
