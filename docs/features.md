# Features

[Back to DoomPi](../README.md)

DoomPi is a distribution, not one giant extension. Each package owns one job; shared TUI,
Cordis services, and session contracts make them behave like one. Use the generated
`default.packages` list together, remove packages you do not want, or replace its entries one
at a time. Selectable packages are not runtime dependencies of the root package or of one another.

## Foundation and interface

### Configuration and composition

[`@agimon-ai/doompi`][pkg-doompi] is both an extension and the command-line config compiler.
`dpi init` creates repository config for an isolated experiment, while `doompi init` creates the
personal config and registers the permanent Pi integration. The sync commands resolve every major
mode and domain into a distribution Pi can load quickly.

### Supporting packages

[`@agimon-ai/doompi-config`][pkg-doompi-config] resolves the four YAML files and exposes the
configuration API. [`@agimon-ai/doompi-domain`][pkg-doompi-domain] owns domain selection, plugin
materialization, resource staging, and MCP scoping.
[`@agimon-ai/doompi-extension-contracts`][pkg-doompi-extension-contracts] contains the shared
Cordis service and event contracts used by extension authors.
[`@agimon-ai/doompi-hashline`][pkg-doompi-hashline] binds edits to the content the model actually
saw. For writable UTF-8 files, [`@agimon-ai/doompi-read`][pkg-doompi-read] and
[`@agimon-ai/doompi-grep`][pkg-doompi-grep] attach an eight-character base64url SHA-256 prefix for
the exact file bytes and a three-letter, whitespace-insensitive FNV-1a64 anchor to each returned
line. Grep still delegates searching to Pi's native ripgrep implementation, and non-writable files
keep Pi's native output so unusable anchors do not consume context.

[`@agimon-ai/doompi-edit`][pkg-doompi-edit] replaces Pi's search-and-replace `edit` tool with
inclusive ranges copied from those results. Before writing, it checks the file tag and range
anchors against the current content, rejects stale or overlapping edits, and applies every range
against the original snapshot. The model receives the protocol metadata, while DoomPi's renderers
hide it from people and keep the usual syntax-highlighted read, grep, and diff views.

[`@agimon-ai/doompi-file-edit`][pkg-doompi-file-edit] opens files in the configured editor and
keeps the edit timeline. [`@agimon-ai/doompi-log`][pkg-doompi-log] collects session events, while
[`@agimon-ai/doompi-telemetry`][pkg-doompi-telemetry] is the library-level telemetry adapter.

Runner selects matching RMUX and RTK native artifacts automatically. Do not install them directly.
The packages cover macOS and Linux on arm64 and x64 for both [RMUX][pkg-rmux-darwin-arm64] and
[RTK][pkg-rtk-darwin-arm64].

### Leader key

[`@agimon-ai/doompi-ui`][pkg-doompi-ui] turns `SPC` into a map of the available commands. It stays out of
the way when a draft is not empty, and other packages contribute bindings through one
leader API instead of hardcoding their own menus.

## Coordinated work

### Agent team

[`@agimon-ai/doompi-team`][pkg-doompi-team] runs named subagents asynchronously. It owns agents,
runs, membership, intercom, and model policy; Task owns the persistent task graph used for
delegation. Agents can work in parallel and message one another. `SPC a l` lists available agents;
`SPC a r` opens current-session runs and their controls.

### Tasks

[`@agimon-ai/doompi-task`][pkg-doompi-task] keeps a task graph on disk, not a disposable checklist in the
transcript. Dependencies persist independently of transcript compaction, and work can be handed to
a subagent, including a smaller model when the job does not need the expensive one. Seeded
`minimal` and `copilot` modes select its `task` layer; omit that layer when a major mode
should not expose the task tool.

### Runner

[`@agimon-ai/doompi-runner`][pkg-doompi-runner] replaces Pi's blocking `bash` tool with
supervised command execution. `doompi init` includes Runner in `default.packages`, so every
generated mode gets it. Short commands still return inline; commands that pass the configurable
threshold of 60 seconds by default move into the background with durable logs. Use
`background: true` for an immediate detached run or `interactive: true` when the command needs
terminal input. Runner IDs and complete raw logs remain available to the current session through
Runner Space at `SPC r l` or the `doom-runner` CLI. Platform-specific RMUX binaries are selected
automatically; non-interactive commands use a supervised subprocess fallback when RMUX is absent,
while interactive commands require RMUX. For conservatively recognized single commands, Runner
passes the completed raw log through the matching RTK stdin filter before returning bounded output.
Compound shell commands, pipelines, incompatible formats, and unsupported commands keep bounded raw
output. Remove Runner from `default.packages` to keep Pi's `bash`, or add it to a named layer when only
selected modes should replace `bash`.

### Auto-compact

Ordinary compaction waits for one summary to save an overgrown session.
[`@agimon-ai/doompi-autocompact`][pkg-doompi-autocompact] leaves checkpoints instead:

1. At 50%, it writes the first compact summary.
2. Later, it combines that summary with the messages since; the model decides whether the
   result is ready to use.
3. On the third pass, it combines them again and forces compaction.

The work runs off-thread and can make up to three additional summarization calls. The standard
adapter preserves staged conversation checkpoints; Task and Team keep their own state rather than
being embedded as special snapshots in the compact summary.

## Context and access

### Help mode

[`@agimon-ai/doompi-help`][pkg-doompi-help] keeps package guidance out of the default prompt. A
fresh parent session performs no Help retrieval and exposes no Help skills. Use `SPC h e`, or the
existing `minor_mode` client in headless sessions, to activate the package indexes; use the same
action to deactivate them before the next interaction. While active, package contributors expose
two catalog groups:

- **How to author:** `doompi-author-extension`, `doompi-author-config`,
  `doompi-author-major-mode`, `doompi-author-domain`, `doompi-author-profile`,
  `doompi-author-hook`, `doompi-author-workflow`, and `doompi-author-skill`.
- **How to use:** `doompi-use-help`, `doompi-use-voice`, `doompi-use-plan`, `doompi-use-goal`,
  `doompi-use-loop`, `doompi-use-workflow`, `doompi-use-runner`, `doompi-use-mcp`, and
  `doompi-use-skill`.

The exact set follows the packages active in that composition. Parent and detached-child sessions
both include the Help runtime. A child receives only contributions from packages activated in that
child, so root and axis authoring guides remain parent-owned when those packages are absent. All
guidance stays withdrawn until Help mode is activated.

### MCP

[`@agimon-ai/doompi-mcp`][pkg-doompi-mcp] is the gate between a session and its servers. It reads
repository and legacy plugin `.mcp.json` plus Agent Plugins v1 `mcp.json`, then exposes only the
servers and proxy upstreams allowed by the selected domains. A domain switch persists an immutable
projection; after Pi replaces the factories, Config publishes it through the session Cordis
registry and MCP starts a fresh in-memory `mcp-proxy` container. No Hono server or localhost proxy
sits in this path.

### Ask user question

[`@agimon-ai/doompi-user-feedback`][pkg-doompi-user-feedback] gives the agent a structured question
that actually waits for an answer. In autonomous Voice mode it skips the modal, narrates the
choices, and accepts the next spoken response as an ordinary user message.

### Logging and telemetry

DoomPi logging records operational metadata such as counters, spans, session IDs, tool names, and
errors. Callers remain responsible for values they attach to telemetry. `SPC h l` opens current-session
metrics, and [`@agimon-ai/log-sink-mcp`][pkg-log-sink-mcp] provides historical lookup when a sink is
configured.

## Modes and automation

### Plan mode

A promise to "only plan" is not a permission boundary. [`@agimon-ai/doompi-plan`][pkg-doompi-plan]
removes Pi's `edit` and `write` tools while the agent explores, persists the plan, and hands it back
for approval. It does not sandbox Bash, external tools, or the operating system. `SPC p e` enters
normal planning and leaves it again once on; `SPC p d` is debug planning and `SPC p f` the Fable
flow.
Turn it on when the approach should be settled before the files move.

### Loop mode

[`@agimon-ai/doompi-loop`][pkg-doompi-loop] is an in-session scheduler. It runs a prompt immediately
and then repeats it on an interval; several loops can coexist. Use `SPC l s` to start one and
`SPC l l` to list or stop them. It is for recurring checks and prompts that belong to the current
session.

### Goal mode

[`@agimon-ai/doompi-goal`][pkg-doompi-goal] pins one objective to the session until it completes or
you end it. `SPC g e` starts a goal and ends it once one is held; `SPC g g` shows status and
`SPC g l` lists repository history. Finished goals stop contributing active instructions and tools but remain in history when
you want to restart one.

### Workflow mode

[`@agimon-ai/doompi-workflow`][pkg-doompi-workflow] runs GitHub Actions-style job graphs with
dependencies, timeouts, artifacts, and a separate DoomPi session for each step. Use `SPC w l` to
browse the repository's workflows and launch one with `r`, `SPC w r` to inspect this session's runs,
`SPC w c` to recover a failed run, and `SPC w e` to give the agent workflow tools or take them back. It is for work that needs hard job boundaries and explicit
handoffs rather than one long conversation.

### Voice mode

[`@agimon-ai/doompi-voice`][pkg-doompi-voice] captures PCM audio through the local platform helper
and can transcribe it locally. Transcript text, session state, and model requests may still cross
process or provider boundaries according to the configured engines. `SPC v v` is one-shot manual
dictation and never enables Voice tools. `SPC v e` enters autonomous capture and exits it again; only its exact-active
TUI session receives the two Voice façades plus the standalone `narrate` tool.

While `narrate` is available, the primary agent calls it before every user-facing final
response. One concise spoken answer is enough for a short conversation or clarification;
longer work also gets an opening and meaningful milestone calls. Each ready-to-speak
utterance is limited to 4,096 characters, waits for physical playback, and returns
`completed`, `interrupted`, `superseded`, or `failed`.

If the agent never attempts `narrate` during a run, exact-active Voice speaks one sanitized
turn-end fallback rather than leaving the final response silent. Finals of at most 320
characters use deterministic speech; longer finals use the configured
`voice.autoCapture.model` for one bounded summary, with deterministic degradation on
failure or timeout. Any `narrate` attempt suppresses this safety net, so it cannot duplicate
or retry direct speech. Voice does not generate automatic intent, plan, milestone, or tool
progress narration. External task, workflow, and user-feedback narration remains
available, and the same model continues to provide bounded command correction.

[pkg-doompi]: https://www.npmjs.com/package/@agimon-ai/doompi
[pkg-doompi-ui]: https://www.npmjs.com/package/@agimon-ai/doompi-ui
[pkg-doompi-config]: https://www.npmjs.com/package/@agimon-ai/doompi-config
[pkg-doompi-domain]: https://www.npmjs.com/package/@agimon-ai/doompi-domain
[pkg-doompi-hashline]: https://www.npmjs.com/package/@agimon-ai/doompi-hashline
[pkg-doompi-read]: https://www.npmjs.com/package/@agimon-ai/doompi-read
[pkg-doompi-grep]: https://www.npmjs.com/package/@agimon-ai/doompi-grep
[pkg-doompi-edit]: https://www.npmjs.com/package/@agimon-ai/doompi-edit
[pkg-doompi-file-edit]: https://www.npmjs.com/package/@agimon-ai/doompi-file-edit
[pkg-doompi-log]: https://www.npmjs.com/package/@agimon-ai/doompi-log
[pkg-doompi-telemetry]: https://www.npmjs.com/package/@agimon-ai/doompi-telemetry
[pkg-rmux-darwin-arm64]: https://www.npmjs.com/package/@agimon-ai/doompi-runner-rmux-darwin-arm64
[pkg-rmux-darwin-x64]: https://www.npmjs.com/package/@agimon-ai/doompi-runner-rmux-darwin-x64
[pkg-rmux-linux-arm64]: https://www.npmjs.com/package/@agimon-ai/doompi-runner-rmux-linux-arm64
[pkg-rmux-linux-x64]: https://www.npmjs.com/package/@agimon-ai/doompi-runner-rmux-linux-x64
[pkg-rtk-darwin-arm64]: https://www.npmjs.com/package/@agimon-ai/doompi-runner-rtk-darwin-arm64
[pkg-rtk-darwin-x64]: https://www.npmjs.com/package/@agimon-ai/doompi-runner-rtk-darwin-x64
[pkg-rtk-linux-arm64]: https://www.npmjs.com/package/@agimon-ai/doompi-runner-rtk-linux-arm64
[pkg-rtk-linux-x64]: https://www.npmjs.com/package/@agimon-ai/doompi-runner-rtk-linux-x64
[pkg-doompi-team]: https://www.npmjs.com/package/@agimon-ai/doompi-team
[pkg-doompi-task]: https://www.npmjs.com/package/@agimon-ai/doompi-task
[pkg-doompi-runner]: https://www.npmjs.com/package/@agimon-ai/doompi-runner
[pkg-doompi-autocompact]: https://www.npmjs.com/package/@agimon-ai/doompi-autocompact
[pkg-doompi-help]: https://www.npmjs.com/package/@agimon-ai/doompi-help
[pkg-doompi-mcp]: https://www.npmjs.com/package/@agimon-ai/doompi-mcp
[pkg-doompi-user-feedback]: https://www.npmjs.com/package/@agimon-ai/doompi-user-feedback
[pkg-log-sink-mcp]: https://www.npmjs.com/package/@agimon-ai/log-sink-mcp
[pkg-doompi-plan]: https://www.npmjs.com/package/@agimon-ai/doompi-plan
[pkg-doompi-loop]: https://www.npmjs.com/package/@agimon-ai/doompi-loop
[pkg-doompi-goal]: https://www.npmjs.com/package/@agimon-ai/doompi-goal
[pkg-doompi-workflow]: https://www.npmjs.com/package/@agimon-ai/doompi-workflow
[pkg-doompi-voice]: https://www.npmjs.com/package/@agimon-ai/doompi-voice
[pkg-doompi-extension-contracts]: https://www.npmjs.com/package/@agimon-ai/doompi-extension-contracts
