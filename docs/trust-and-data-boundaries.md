# Trust and data boundaries

[Back to DoomPi](../README.md)

## Executable inputs

DoomPi executes the extensions, remote Git/npm plugins, hooks, MCP stdio commands, workflows, and
shell commands you configure. Treat them as trusted executable code. Runner commands inherit the
process environment and operating-system privileges; their logs may contain command output and
secrets. MCP credentials may live in the system keyring or private configuration files.

## Approval prompts in compatibility mode

`doompi compat <codex|claude|antigravity>` resolves the DoomPi matrix and then launches a third-party
frontend. By default it leaves that frontend's own approval behavior alone.

Passing `--skip-permissions` disables it for that run:

| Provider      | What DoomPi passes with `--skip-permissions` |
| ------------- | -------------------------------------------- |
| `claude`      | `--dangerously-skip-permissions`             |
| `codex`       | `--yolo` (full auto, no sandbox)             |
| `antigravity` | `--dangerously-skip-permissions`             |

Without the flag, none of these are passed. Every run that does bypass prints a warning to stderr
naming the provider, because a frontend that has stopped asking looks the same as a frontend that had
nothing to ask about.

Scoping which tools load and deciding whether a tool call needs confirmation are separate questions.
DoomPi answers the first one. `--skip-permissions` is you answering the second.

`compat antigravity` also writes to Antigravity's own settings file
(`~/.gemini/.../settings.json`): it sets a default `model` when none is set, and adds the repository
root to `trustedWorkspaces`. That entry outlives the run, so the path of the file being changed is
printed to stderr when it is added.

## Bundled native binaries

DoomPi Runner ships prebuilt third-party executables under
`packages/default/doompi-runner-{rmux,rtk}-*/vendor/`. They run with your full user privileges.

| Binary                | Upstream                                          | Version                          | License           |
| --------------------- | ------------------------------------------------- | -------------------------------- | ----------------- |
| `rmux`, `rmux-daemon` | [Helvesec/rmux](https://github.com/Helvesec/rmux) | tag `v0.9.1`, commit `fb827cd7`  | MIT OR Apache-2.0 |
| `rtk`                 | [rtk-ai/rtk](https://github.com/rtk-ai/rtk)       | tag `v0.45.0`, commit `b34be37c` | Apache-2.0        |

Both are general-purpose tools that carry features DoomPi does not use. RMUX includes a `web-share`
command that can expose panes over a public tunnel with pairing codes; **DoomPi never invokes it**,
and no DoomPi code path passes `web-share`, `--web-port`, or `--frontend-url`. DoomPi Runner uses
RMUX for session and pane supervision and RTK for log processing, nothing else.

RTK has its own upstream telemetry, documented at
[rtk-ai/rtk TELEMETRY.md](https://github.com/rtk-ai/rtk/blob/master/docs/TELEMETRY.md). It is
governed by that project, not by DoomPi's telemetry controls below.

## Model calls

Voice can keep PCM capture and transcription local when local engines are selected, but transcript
text and model requests follow the configured providers. Loop, Workflow, Plan, Autocompact, Team, and
autonomous Voice can make additional model calls.

## Telemetry

DoomPi ships no telemetry endpoint of its own. There is no vendor collector, and nothing is sent
anywhere unless an OTLP endpoint is configured or discovered in your environment. With none present,
telemetry initialization returns nothing and stays disabled.

To turn it off outright, set either of these to a truthy value:

```bash
AGENT_TELEMETRY_DISABLED=1
OTEL_SDK_DISABLED=1
```

Values supplied by callers are not automatically scrubbed, so treat attribute payloads the way you
would treat log output.
