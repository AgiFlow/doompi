# Trust and data boundaries

[Back to DoomPi](../README.md)

## Executable inputs

DoomPi executes the extensions, remote Git/npm plugins, hooks, MCP stdio commands, workflows, and
shell commands you configure. Treat them as trusted executable code. Runner commands inherit the
process environment and operating-system privileges; their logs may contain command output and
secrets. MCP credentials may live in the system keyring or private configuration files.

`doompi --explain` is included in this. To report what MCP tool schemas cost in context it starts
each configured stdio server, asks it for its tool list, and stops it again. The servers run with
the same privileges a session gives them, so a command you would not want executed should not be
configured. Results are cached under `~/.pi/.doom/mcp-schema-cache` and keyed on the server
command, arguments, and environment, so a server is only started again when that descriptor
changes. Use `--no-mcp` to inspect a selection without starting anything.

## Sandboxed launches

`doompi --sandbox` moves a session's blast radius off the host. A layer that exports
`./sandbox-harness` (the bundled one is `@agimon-ai/doompi-sandbox`) runs the entire agent,
extensions, MCP servers, skills, and tools inside a disposable Docker or Podman container while
the terminal stays attached.

What a sandboxed session can reach:

- The repository, bind-mounted read-write at its host path. The rest of the host filesystem is
  invisible, including `~/.ssh`, keychains, host Pi sessions, and other repositories.
- An isolated home directory and an isolated `.pi` package store, both named volumes keyed to the
  repository path, so Linux installs never touch the host's platform-specific packages.
- An allowlisted environment: terminal and locale variables, proxy settings, and `DOOMPI_PRESET`.
  Everything else a shell accumulates stays on the host.
- The network, under the engine's default configuration. Network policy is not restricted yet.

### Provider credentials

A sandboxed session holds no provider API key. The host starts a broker on a unix socket, mounts
only that socket into the container, and gives the container a random per-session token in place of
every credential. Pi inside the container is redirected at the socket, presents the token, and the
broker swaps it for the real key before forwarding upstream. A call that cannot prove possession of
the token is refused, and a provider the session was not granted is unroutable.

Credentials for providers the broker does not carry are withheld from the container entirely
rather than passed through, so the promise holds for every provider rather than the brokered ones
only. Set `DOOMPI_SANDBOX_BROKER=0` to turn brokering off and hand credentials to the container
directly, which is the pre-broker behavior.

Known limits of this boundary today:

- The broker terminates a curated provider list. A session that authenticates any other way, in
  particular OAuth subscription logins held in `~/.pi`, has to log in inside the sandbox because
  the host home directory is not mounted.
- A `*_BASE_URL` override on the host is dropped rather than honored as the broker's upstream, so
  a session pointed at a corporate gateway needs brokering turned off.
- The token authorizes any brokered provider for the life of the session; the broker does not cap
  spend or rate.
- The container engine daemon is part of the trusted base; a user or process that can talk to
  Docker can escape any container it runs.
- Compositions that declare local workspace packages cannot load their platform-specific
  dependencies inside the Linux container; sandboxed sessions expect registry-installed layers.
- `--sandbox` belongs to the `doompi` launcher. The synced `dpi` fast path does not accept it yet.

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
