# @agimon-ai/doompi-hook

Repository, personal, and Claude Code-compatible plugin hooks for
[DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) sessions. Registry rows can run shell commands or compiled TypeScript/JavaScript modules.

> **Alpha:** hook configuration and runtime contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 1.0.0
- `/bin/bash` for command hooks

## Registry and activation

```yaml
# .doom/hooks.yaml
groups:
  safety:
    core: true
    hooks:
      - event: PreToolUse
        pi:
          matcher: Bash
          module: .doom/hooks/guard.ts
          timeout: 10
          order: 0
  workflow:
    hooks:
      - event: Stop
        pi:
          command: .doom/hooks/close-workflow-step.sh
          skipInSubagent: true
```

Each `pi` binding declares exactly one of `command` or `module`. Module paths resolve relative to the declaring repository root or personal `~/.pi/.doom` root, not the directory containing `hooks.yaml`. Personal configuration is `~/.pi/.doom/hooks.yaml`; repository configuration is `<repo>/.doom/hooks.yaml`. A repository group replaces the personal group of the same ID completely.

The distribution activates this package by default through the `default.packages` list written by `doompi init` or `dpi init`. Keep it there, or declare it in a selected layer. Layers only declare the `hookGroups` to select; they do not define hook implementations:

```yaml
# .doom/modes.yaml
layers:
  repository-hooks:
    hookGroups: [safety, workflow]
```

`core: true` always loads. Unset `hookGroups` means all groups; explicit `hookGroups: []` means core groups only. An explicit nonempty list selects those groups plus core. Lower `order` values run first, with declaration order breaking ties. Registry commands and modules interleave in that order, followed by plugin commands. An explicit denial ends the chain.

`matcher` is a regular expression over Claude tool names such as `Bash` and `Write`. Modules receive native Pi events and tool names such as `bash`, not translated command payloads. `skipInSubagent: true` excludes a registry row from child tool dispatch. Use it for parent-owned work; it does not enable child lifecycle dispatch.

## Compiled module authoring

Use the dependency-free public authoring subpath, not the extension/runtime entry:

```ts
import { defineDoomHook } from '@agimon-ai/doompi-hook/authoring';

export default defineDoomHook({
  setup(ctx) {
    let calls = 0;
    return {
      tool_call(event, ctx) {
        calls += 1;
        if (event.toolName === 'bash' && String(event.input.command).includes('rm -rf')) {
          return { block: true, reason: 'Use a non-destructive command.' };
        }
      },
      async dispose() {
        // Release resources owned by this session's setup.
      },
    };
  },
});
```

`defineDoomHook` checks the contract while preserving inference. The default export must have `setup(ctx)`, returning handlers synchronously or asynchronously. Only handlers selected by registry rows run:

| Registry event | Native module handler       | Result                                           |
| -------------- | --------------------------- | ------------------------------------------------ |
| `SessionStart` | `session_start(event, ctx)` | `void`                                           |
| `PreToolUse`   | `tool_call(event, ctx)`     | `void` or `{ block?: boolean, reason?: string }` |
| `PostToolUse`  | `tool_result(event, ctx)`   | `void` or `{ content?, details?, isError? }`     |
| `Stop`         | `agent_settled(event, ctx)` | `void`, cannot send messages                     |

Optional `dispose()` returns void or a promise. There is no module `SessionEnd` handler. Tool-call handlers may mutate `event.input`, which must remain a JSON object. Accepted mutations flow to later rows and the tool. Tool-result patches accept text/image content, JSON-compatible details, and a boolean error flag. Failed, invalid, or late invocations cannot publish input mutations or result patches. Lifecycle handlers cannot return decisions.

### Full HookContext contract

The authoring subpath exports `HookContext`, `HookHandlers`, `HookModule`, `HookModuleDescriptor`, `AgentSettledEvent`, `Awaitable`, and `JsonValue` types.

```ts
interface HookContext {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly agent?: string;
  readonly isSubagent: boolean;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly signal: AbortSignal;
  sendMessage(text: string, delivery: 'steer' | 'followUp'): Promise<void>;
  appendCustomEntry(type: string, data: JsonValue): Promise<void>;
}
```

`cwd` is the session working directory; `repoRoot` is its resolved repository root. Optional identity/model fields may be absent, including model in native children. Await context effects. Message delivery uses host prompt admission; admission failures propagate, they are not converted to advisory hook failures. `appendCustomEntry` records JSON-compatible data in session history.

Setup and row calls for the same module and session are serialized. A module referenced by multiple rows shares one setup instance in that session. Keep mutable state inside `setup`, not at module scope: imported modules may be shared across sessions, while setup closures are session-local. In-memory state is not durable across reloads. Explicitly record history entries when durability is needed.

Setup receives a lifetime context; handlers receive an invocation context whose signal also reflects cancellation. Invocation effects are revoked after completion. Setup failure, setup/handler timeout, or cancellation quarantines the instance and revokes its context effects. Cooperate with `signal`; revocation cannot stop arbitrary JavaScript or undo already completed external effects.

## Command payloads and decisions

Commands run through `/bin/bash -c` in the repository root with a Claude-compatible JSON payload on stdin. The environment includes `CLAUDE_PROJECT_DIR`, `CODEX_REPO_ROOT`, `ORIGINAL_REPO_PATH`, and `CLAUDE_PLUGIN_ROOT`. The last field names the root declaring the repository, personal, or plugin configuration. Native child tool payloads use the child's own `session_id` and include `parent_session_id` and `agent_type`.

The last stdout line beginning with `{` is parsed as the decision. Denial is `decision: "block"` or `hookSpecificOutput.permissionDecision: "deny"`; the reason is top-level `reason` or `hookSpecificOutput.reason`. Context is `hookSpecificOutput.additionalContext`.

| Event          | Command decision behavior                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SessionStart` | Adds additional context to the conversation                                                                                                                                          |
| `PreToolUse`   | Denial blocks the call. Additional context also blocks the current call with that text as its reason, allowing the agent to reconsider; it does not silently steer an executing tool |
| `PostToolUse`  | Appends additional context or reason to the result; denial marks it as an error                                                                                                      |
| `Stop`         | Denial with a reason requests a follow-up turn, capped at five consecutive refusals                                                                                                  |
| `SessionEnd`   | Plugin commands only, run for side effects                                                                                                                                           |

Stop payloads include `stop_hook_active` when a prior refusal is active. After five consecutive refusals, a further refusal is reported without another follow-up turn. A stop without a refusal reason resets the count. This continuation contract belongs to commands, not module `agent_settled` handlers.

## Event ownership and children

Terminal parents use Pi tool and lifecycle handlers. In headless parents, the Pi bridge owns lifecycle rows: `SessionStart`, `Stop`, and plugin-only `SessionEnd`. Server facets alone own headless tool dispatch. The bridge and server tool path share session-local module setup, so lifecycle and tool rows do not create separate instances. Session-start readiness precedes dependent turns/tools. Session-end runs once during shutdown before service disposal.

Native children, through either the headless or terminal adapter, run only `PreToolUse` and `PostToolUse`. Registry and plugin tool hooks run, excluding registry rows marked `skipInSubagent`. Children do not run `SessionStart`, `Stop`, or `SessionEnd`. Each child has its own module setup/state and pins its launch selection and module generation, even after the parent reloads or disposes.

## Sync, reload, and failure handling

After changing a module or its imports, registry, or mode selection:

1. Run `doompi sync` (or `dpi sync`). Sync compiles core modules plus the union of mode-selected groups; if any mode leaves selection unset, it compiles all groups.
2. Run `doompi sync --check` to check drift.
3. Use `/reload` or restart the terminal session to adopt the published generation. Reopen headless sessions, then exercise the intended events.

Module imports use compiled artifacts from a synchronized descriptor, never a live source fallback. The runtime pins the descriptor at binding creation, including cold lazy imports after configuration replacement. A compilation failure preserves the previous published generation. Sync alone does not replace modules in a running session.

`timeout` is a positive finite number of seconds, defaulting to 10. For modules, the invocation budget includes first import/setup and the handler. Module execution/setup errors, invalid results, and timeouts are advisory, reported as missed checks rather than automatically denying tools. Host readiness, cancellation, and context effect/admission failures are not advisory execution failures. A quarantined module does not resume checking later rows in that session.

Command nonzero exits, spawn failures, invalid JSON, and timeouts are likewise advisory. Timed-out command process groups receive `SIGTERM`, then `SIGKILL` two seconds later.

## Trust and isolation limits

Hooks are executable trusted code. Compilation and generation pinning provide artifact consistency, not a sandbox or authorization boundary. Modules execute in the host Node.js process with its filesystem, network, and process privileges; commands inherit host privileges too. A synchronous infinite loop, `process.exit`, or out-of-memory failure cannot be contained in-process. Prefer `command:` when process isolation and hard termination matter. Session-local setup and serialized calls do not isolate module globals or external side effects. Context revocation only gates the exposed context effects. Do not load untrusted hooks or treat advisory checks as guaranteed enforcement.

## Verification scope

Functional proof covers real Pi bridge exactly-once dispatch, shared lifecycle/tool setup, prompt-admission marker propagation, in-flight cancellation, native command rows, cold descriptor pinning, and both native child adapters retaining modules after parent disposal. Direct/MCP command-row proof uses explicitly mocked tool bodies. This does not establish full intercom plugin integration.

## Help, install, and public API

Help minor mode contributes `doompi-author-hook` while this package and its Help provider are active.

```bash
pi install npm:@agimon-ai/doompi-hook
```

```ts
import { createBashHookRunner, hookExtension } from '@agimon-ai/doompi-hook';
import type { HookDecision, HookEventName } from '@agimon-ai/doompi-hook';
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Routed roots and named handlers live under `src/extensions/workspaces/sessions/(backend)/`. `services/hookRuntime/` owns readiness and session lifetimes. The package build generates Pi/server entries; `src/exports/` publishes reusable capabilities.

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
