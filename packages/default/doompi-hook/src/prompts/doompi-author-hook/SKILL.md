---
name: doompi-author-hook
description: Author DoomPi repository or plugin hooks. Use when creating or changing .doom/hooks.yaml, selecting hook groups from modes.yaml, writing hook commands, or adapting Claude Code hook payloads and decisions to DoomPi.
---

# Author DoomPi hooks

Write the smallest hook that enforces the requested policy. Hooks are trusted executable code, not sandboxed guardrails.

## Registry and selection

Define personal hooks in `~/.pi/.doom/hooks.yaml` and repository hooks in `<repo>/.doom/hooks.yaml`:

```yaml
groups:
  safety:
    core: true
    hooks:
      - event: PreToolUse
        pi:
          matcher: Bash
          module: .doom/hooks/guard.ts
          timeout: 10
          skipInSubagent: true
          order: 0
```

- Each `pi` row declares exactly one of `command` or `module`. Module paths resolve relative to the declaring repository root or `~/.pi/.doom` root.
- A repository group replaces a personal group of the same ID completely.
- `core: true` always runs. Unset `hookGroups` means all groups; explicit `hookGroups: []` means core only. An explicit list selects those groups plus core.
- Keep `@agimon-ai/doompi-hook` in active packages. Layers select groups through `hookGroups` in `modes.yaml`.
- `matcher` is a regular expression over Claude tool names such as `Bash` and `Write`, including for module rows.
- Lower `order` runs first, then declaration order. Registry commands/modules interleave before plugin commands. Explicit denial ends the chain.
- `skipInSubagent: true` excludes a row from child tool dispatch. Use it for parent-owned effects, not to control lifecycle ownership.

## Lightweight module API

Import from the dependency-free authoring subpath:

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
        // Release session-owned resources.
      },
    };
  },
});
```

The default export must expose `setup(ctx)`, returning handlers synchronously or asynchronously. Registry events select native handlers:

- `SessionStart`: `session_start(event, ctx)`, returns void.
- `PreToolUse`: `tool_call(event, ctx)`, returns void or `{ block?: boolean, reason?: string }`.
- `PostToolUse`: `tool_result(event, ctx)`, returns void or `{ content?, details?, isError? }`.
- `Stop`: `agent_settled(event, ctx)`, returns void and cannot send messages.
- Optional `dispose()` returns void or a promise. No module `SessionEnd` exists.

Native events use Pi tool names such as `bash`. Tool-call handlers may mutate `event.input`, which must remain a JSON object. Accepted changes reach later rows and the tool. Tool-result patches support text/image content, JSON-compatible details, and a boolean `isError`. Failed, invalid, or late calls cannot publish mutations or patches. Lifecycle handlers cannot return decisions.

## Full HookContext contract

The authoring API exports `HookContext`, `HookHandlers`, `HookModule`, `HookModuleDescriptor`, `AgentSettledEvent`, `Awaitable`, and `JsonValue` types:

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

Optional identity/model fields may be absent, including model in native children. `cwd` is the session working directory; `repoRoot` is its resolved repository root. Await context effects. Messages use host prompt admission; admission failures propagate rather than becoming advisory hook failures. Custom entries persist JSON-compatible data in session history.

Setup and row calls for one module/session are serialized. Multiple rows share one setup instance. Store mutable session state in the setup closure, never module globals, which may be shared across sessions. Closure state is not durable across reloads; record custom entries explicitly when needed.

Setup gets a lifetime context; handlers get invocation contexts reflecting cancellation. Invocation effects are revoked after completion. Setup failure, setup/handler timeout, or cancellation quarantines the instance and revokes its effects. Honor `signal`; revocation cannot terminate arbitrary JavaScript or undo completed external effects.

## Command payloads and decisions

Commands run through `/bin/bash -c` from the repository root with Claude-compatible JSON on stdin. Environment fields include `CLAUDE_PROJECT_DIR`, `CODEX_REPO_ROOT`, `ORIGINAL_REPO_PATH`, and `CLAUDE_PLUGIN_ROOT`, the declaring root. Native child payloads use the child's own `session_id`, plus `parent_session_id` and `agent_type`.

The final stdout line beginning with `{` is parsed. Denial is `decision: "block"` or `hookSpecificOutput.permissionDecision: "deny"`. Reasons use top-level `reason` or `hookSpecificOutput.reason`; context uses `hookSpecificOutput.additionalContext`.

- `SessionStart` adds additional context to the conversation.
- `PreToolUse` denial blocks. Additional context also blocks the current call with that text as its reason so the agent can reconsider, rather than silently steering execution.
- `PostToolUse` appends additional context or reason; denial marks the result as an error.
- `Stop` denial with a reason requests a follow-up turn. At most five consecutive refusals schedule follow-ups; a further refusal is reported and stops without another turn. A stop without a refusal reason resets the count. `stop_hook_active` indicates a prior active refusal.
- `SessionEnd` is plugin-command-only and runs for side effects.

Module `agent_settled` cannot implement command Stop continuation by returning a decision or sending a message.

## Ownership, sync, and failures

Terminal parents use Pi tool and lifecycle handlers. For headless parents, the Pi bridge owns `SessionStart`, `Stop`, and plugin `SessionEnd`; server facets alone own tool dispatch. Lifecycle/tool paths share session module setup. Session-start readiness gates dependent turns/tools. Shutdown runs session-end once before disposal.

Native children in both adapters run only `PreToolUse` and `PostToolUse`, never lifecycle rows, regardless of `skipInSubagent`. Children have separate setup/state and retain their launch selection and compiled modules after parent reload/disposal.

After editing modules/imports, registry, or selection, run `doompi sync` or `dpi sync`, check with `doompi sync --check`, then use `/reload` or restart the terminal session. Reopen headless sessions. Sync compiles core plus the union of mode-selected groups, or all groups if any mode leaves selection unset. Compile failure preserves the previous published generation. Runtime imports only descriptor-mapped compiled artifacts, with no live source fallback. Descriptor selection is pinned at binding creation, even for cold lazy imports after replacement configuration. Sync alone does not update a running session.

`timeout` is positive finite seconds, default 10. A module's first invocation budget includes import/setup and handler execution. Execution/setup errors, invalid results, and timeouts are advisory missed checks, not automatic denials. Quarantined instances do not resume checks in that session. Host readiness, cancellation, and context effect/admission failures are not advisory execution failures. Command nonzero exits, invalid JSON, spawn failures, and timeouts are advisory; timeout terminates the process group with SIGTERM then SIGKILL two seconds later.

Compilation/pinning ensure consistency, not isolation or authorization. Modules run in the host Node.js process with host privileges. Synchronous infinite loops, `process.exit`, and out-of-memory failures cannot be contained in-process. Prefer `command:` when process isolation and hard termination matter. Serialization and session-local setup do not isolate globals, filesystem/network access, or external effects. Context revocation gates only the exposed context methods. Do not run untrusted hooks or promise guaranteed enforcement from advisory checks.

## Verification

1. Run commands directly with representative stdin JSON; sync module sources and their imports.
2. Confirm activation with the intended mode and `doompi --explain`.
3. Reload/restart and exercise exact events in a disposable session, including child tool calls, cancellation, timeout, and `skipInSubagent` behavior.
4. Check failure reporting, shared lifecycle/tool setup, result/input changes, and once-only shutdown.
5. Distinguish runtime proof from mocks: verified functional proof covers real Pi bridge dispatch, shared setup, admission markers, cancellation, native command rows, cold descriptor pinning, and both real native child adapters. Direct/MCP command-row proof explicitly mocks tool bodies. Do not claim full intercom plugin integration from that evidence.
