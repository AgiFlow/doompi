# @agimon-ai/doompi-runner

Supervised shell execution, background process control, durable logs, and Runner Space for Pi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Runner replaces Pi's built-in `bash` tool only in sessions that load it. Short commands return
inline; long commands can be promoted to a background runner instead of blocking the agent.

> **Alpha:** tool and process contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.2 and Pi TUI 0.84.2
- `/bin/bash`
- macOS or Linux on arm64 or x64 for bundled RMUX and RTK support

Linux native loading also depends on a compatible system loader and libc. The bundled binaries are
glibc-linked, so a musl host such as Alpine cannot run them.

RTK is optional. Where its binary is absent or cannot start, runner results carry the raw log with
an "RTK is unavailable" note instead of processed output. That verdict is reached once per process
rather than retried per command, so an unusable binary costs one failed start rather than one on
every run.

Panes come from the first backend that answers: bundled RMUX, then `rmux` on PATH, then `tmux` on
PATH. Only when none is available does a non-interactive command fall back to a supervised
subprocess, and interactive commands need one of them. A tmux-backed run is supervised by the same
host process as an RMUX one, so exit metadata and logs behave the same; its session names carry a
`doom-tmux-` prefix rather than `doom-runner-`.

## Install

DoomPi includes Runner in every composition, so no layer declaration is required. For direct Pi
installation:

```bash
pi install npm:@agimon-ai/doompi-runner
```

Pi discovers Runner's sole extension factory from `package.json.pi.extensions`. The extension joins
the runner-scoped Cordis host and releases its plugin resources and host lease when the Pi session
shuts down.

## Use the `bash` tool

```json
{
  "command": "pnpm test",
  "timeout": 60
}
```

Commands crossing the promotion threshold move to a supervised runner. The default threshold is 60
seconds. Set `background: true` to detach immediately, or `interactive: true` only when a command
needs terminal input.

Runner requires `PI_SESSION_ID` for session ownership. Processes, controls, and logs remain
addressable after transcript compaction because their identity is outside model context.

### RTK result processing

Runner keeps the complete original log, then uses the matching RTK stdin filter only for
conservatively recognized single commands. Current safe mappings cover `cargo test`, `pytest`, plain
unified `git diff`, structured `grep` or `rg`, `go test -json`, and JSON-formatted `ruff check`.
Compound commands, pipelines, redirects, substitutions, incompatible formats, unsupported commands,
and logs above RTK's 10 MiB stdin limit return bounded raw output instead. An eligible RTK failure
also returns bounded raw output with a warning and does not change the command exit result.

## Inspect and control runs

Use `/runners` or `SPC r l` in the TUI. The `doom-runner` CLI supports:

```bash
doom-runner list
doom-runner status <runner-id>
doom-runner logs <runner-id>
doom-runner input <runner-id> --text "y" --enter
doom-runner stop <runner-id>
doom-runner stop-all
```

The `input` command requires a running interactive process backed by RMUX or tmux.

Stop runs that are no longer required.

## Storage and limits

By default, session-scoped logs and registry data live under:

```text
~/.pi/agent/doom-runner/<session>/
```

Logs remain complete until TTL cleanup and are eligible for cleanup after seven days by default. The
legacy log-size configuration exports remain available for compatibility but no longer rotate log
content. Result limits, retention, and the promotion threshold remain environment-configurable.

### Result excerpts

A result that exceeds the ceiling is returned as an excerpt: roughly the first fifth of the budget
holds the opening lines, the rest holds the closing ones, and a marker between them states how many
lines were dropped.

The budget depends on the exit status. A command that **failed** gets 8 KiB and 120 lines, because
its output is the evidence. A command that **succeeded** gets 2 KiB, because exiting 0 has already
reported the outcome and the rest is mostly progress lines and repeated warnings:

```text
Log excerpt (71 of 604 lines):
$ pnpm build
Compiling 1200 modules...
  compiled src/module-0.ts
… [5 lines elided] …
  compiled src/module-599.ts
Build succeeded in 12.4s
exit status 0
Full log: /path/to/run.log (17.0 KB, 604 lines); inspect with doom-runner logs run-a
```

Three ceilings apply and whichever binds first wins: bytes, lines, and tokens. Tokens are there
because bytes do not track context cost. Measured against `gpt-tokenizer`, real text runs from about
1.4 characters per token for base64 to 4.7 for English prose, so 8 KiB of one costs several times
what 8 KiB of the other does. The defaults are 2,048 tokens on failure and 512 on success.

Token counts are estimated rather than tokenized: truncation runs on every command and is
synchronous, so loading a vocabulary would charge every session for a table most never need. The
estimator models how BPE behaves, with punctuation forcing boundaries, natural words cheap, and
letter-digit runs expensive. Its worst error against `gpt-tokenizer` is a factor of about 1.46
either way, which is why the byte ceiling stays behind it as the hard bound.

`DOOM_RUNNER_RESULT_MAX_BYTES`, `DOOM_RUNNER_RESULT_MAX_TOKENS`, and their
`DOOM_RUNNER_SUCCESS_*` counterparts move these for one invocation. A pragma overrides all of
them, which is how one noisy successful command can still ask for the wider result. Raising only
`maxResultBytes` will not help when the token ceiling is the one binding.

Error lines found in the dropped span are rescued into that marker's block, up to ten entries.
Matching looks for a severity word in the first 60 characters, so `[widget] build: error TS2322`
and a line behind a timestamp both count, while `0 errors`, `no failures`, and `--error-format` do
not. Byte-identical lines collapse to one entry with an occurrence count. Lines that share a shape
but differ in detail keep every variant, joined inside brackets so nothing actionable is lost:

```text
ERROR in [src/widget-100.ts:100:7|src/widget-200.ts:200:7] - Type mismatch
error: connection refused (×40)
```

The complete raw log on disk is never truncated.

### Configuration

Four layers, most specific first: a per-command pragma, then an environment variable, then project
configuration, then the built-in default. Project configuration is the project's baseline, so an
environment variable set for one invocation still wins over it.

One command that needs a wider result can say so on its first line. The pragma is a shell comment,
so it stays harmless to the command itself:

```bash
# @doom: {"maxResultBytes": 32768, "maxResultTokens": 8192, "maxResultLines": 300}
pnpm build
```

Project settings follow Pi's convention for extension configuration: one JSON file per extension
under the config directory, at `.pi/doompi-runner.json`. It is read only when the project is
trusted, and an unrecognized or out-of-range key is reported rather than silently ignored.

```json
{
  "maxResultBytes": 16384,
  "maxResultLines": 200,
  "successMaxResultBytes": 2048,
  "maxResultTokens": 2048,
  "successMaxResultTokens": 512,
  "headRatio": 0.2,
  "errorPatterns": ["^FEHLER", "^\\s*FAILED\\b"],
  "errorMaxEntries": 10,
  "errorMaxVariantsJoined": 6,
  "errorBudgetRatio": 0.2
}
```

`errorPatterns` extends the built-in matcher rather than replacing it, which is what makes output
it does not recognize reachable. Ceilings apply to every numeric key so a checked-in file cannot
flood the model's context.

Commands inherit the DoomPi process environment and the operating system user's privileges. Logs
may contain prompts, source, command output, credentials, or other secrets; restrict access and
retention accordingly.

## Native artifacts

Runner selects the matching optional dependencies automatically:

| Host        | RMUX package                                 | RTK package                                 |
| ----------- | -------------------------------------------- | ------------------------------------------- |
| macOS arm64 | `@agimon-ai/doompi-runner-rmux-darwin-arm64` | `@agimon-ai/doompi-runner-rtk-darwin-arm64` |
| macOS x64   | `@agimon-ai/doompi-runner-rmux-darwin-x64`   | `@agimon-ai/doompi-runner-rtk-darwin-x64`   |
| Linux arm64 | `@agimon-ai/doompi-runner-rmux-linux-arm64`  | `@agimon-ai/doompi-runner-rtk-linux-arm64`  |
| Linux x64   | `@agimon-ai/doompi-runner-rmux-linux-x64`    | `@agimon-ai/doompi-runner-rtk-linux-x64`    |

Do not install platform packages directly. They contain native executables and export only package
metadata. RMUX is dual-licensed under MIT or Apache-2.0. RTK v0.45.0 is licensed under Apache-2.0.

## Public API

```ts
import {
  createRunnerContainer,
  DEFAULT_BG_THRESHOLD_MS,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_TTL_MS,
  RmuxBackend,
  rtkPackageForTarget,
} from '@agimon-ai/doompi-runner';
```

Declared subpaths expose process supervision, configuration, tools, response envelopes, and TUI
integration for host authors.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
