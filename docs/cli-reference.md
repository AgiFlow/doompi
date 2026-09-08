# CLI reference

[Back to DoomPi](../README.md)

The commands fall into three paths:

```text
dpi       side-by-side DoomPi without persisted Pi integration
doompi    explicit DoomPi setup, sync, inspection, and launch harness
pi        normal Pi command after doompi init registers DoomPi
```

Use `dpi` to evaluate the distribution, `doompi init` to make it part of regular Pi startup, and `doompi` when one run needs explicit matrix options.

## Setup and synchronization

| Command               | Effect                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `dpi init`            | Creates missing `.doom` files in the current repository without changing Pi settings.                             |
| `dpi init --force`    | Replaces the repository's four `.doom` files with current templates.                                              |
| `dpi sync`            | Installs required packages and publishes synchronized state for an in-memory Pi settings overlay.                 |
| `dpi`                 | Runs pinned Pi with that in-memory overlay. DoomPi handles `--sandbox`; remaining arguments pass to Pi.           |
| `doompi init`         | Creates missing personal `.doom` files and registers the DoomPi extension alias and theme in Pi settings.         |
| `doompi init --force` | Replaces the four personal `.doom` files and refreshes the Pi integration resources.                              |
| `doompi sync`         | Installs required packages and publishes state for the registered integration without rewriting Pi user settings. |
| `doompi sync --check` | Checks package resolution, drift, artifacts, alias, theme, and Pi settings without writing.                       |
| `doompi doctor`       | Runs the strict configuration check, then everything `sync --check` reports. Changes nothing.                     |

Every command accepts `-h`/`--help`, including the subcommands: `doompi sync --help` prints help rather than running a sync.

`doompi sync` reports unsupported keys in `.doom/config.yaml` and `.doom/modes.yaml` and then ignores them, so a config written against a different version cannot break a build. Invalid values for keys it does recognize still fail. `doompi doctor` is the strict check that reports those keys as problems.

Synchronized state is repository- and worktree-scoped under `~/.pi/.doom/sync`. Publication is atomic and retains one superseded generation. See [Composition and runtime bundling](bundling.md) for the lifecycle.

## Matrix and launch options

The matrix describes the session DoomPi should resolve before Pi starts.

| Option                      | Effect                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `--major-mode <name>`       | Select one major mode from `.doom/modes.yaml`.                                         |
| `--domains <names>`         | Select comma-separated content domains. `--domain` is also accepted.                   |
| `--no-domains`              | Select no domains. It cannot be combined with `--domains`.                             |
| `--profile <name>`          | Select a persona and environment profile.                                              |
| `--mcp`, `--no-mcp`         | Enable or disable MCP configuration for this run.                                      |
| `--agents`, `--no-agents`   | Enable or disable spawnable agent resources.                                           |
| `--hooks`, `--no-hooks`     | Enable or disable repository and plugin hooks.                                         |
| `--plugin-dir <path>`       | Add an explicit plugin directory. Repeat for more than one.                            |
| `--add-dir <path>`          | Add an accessible directory. Repeat for more than one.                                 |
| `--cwd <path>`              | Run Pi in the selected directory. `--cd` is also accepted.                             |
| `--preset <name>`           | Select `default`, `kimi`, or `ollama` provider normalization.                          |
| `--automation`              | Add Pi print mode, JSON output, and project approval unless already supplied.          |
| `--auto-stop`               | Exit an interactive session after the agent settles. Rejected in print and JSON modes. |
| `--sandbox`                 | Run through the sandbox harness exported by a selected layer. `dpi` accepts it too.    |
| `--allow-protected-writes`  | Permit writes to repository paths DoomPi otherwise protects.                           |
| `--mute`                    | Disable DoomPi notifications for this run.                                             |
| `--output-format vibe-lint` | Read one Vibe-Lint request from stdin and write one JSON response.                     |
| `-h`, `--help`              | Print harness help without resolving the repository.                                   |
| `-v`, `--version`           | Print the installed package version.                                                   |

Remaining arguments pass to Pi.

## Inspection and generated output

| Option             | Effect                                                                           |
| ------------------ | -------------------------------------------------------------------------------- |
| `--explain`        | Print the resolved matrix and estimated prompt cost, then exit.                  |
| `--emit-mcp <dir>` | Write resolved MCP configuration to a directory, then exit. MCP must be enabled. |

`--explain` is read-only with respect to DoomPi configuration, but it is not a no-execution boundary. Schema inspection can start each allowed stdio MCP server. Add `--no-mcp` when those commands must not run. See [Executable inputs](trust-and-data-boundaries.md#executable-inputs).

## Compatibility frontends

```bash
doompi compat <codex|claude|antigravity> [matrix options] [provider arguments]
```

Compatibility mode resolves the DoomPi matrix and launches the named frontend. It consumes `--major-mode`, `--domains`, `--domain`, `--profile`, and `--skip-permissions`; other arguments pass through. Use `--` before a provider option whose name collides with a DoomPi option.

`--skip-permissions` disables the frontend's approval prompts for that run. DoomPi maps it to `--dangerously-skip-permissions` for Claude and Antigravity and `--yolo` for Codex, and prints a warning. Scoping the loaded tools and approving individual actions are separate controls. See [Approval prompts in compatibility mode](trust-and-data-boundaries.md#approval-prompts-in-compatibility-mode).

## Diagnostics

```bash
doompi doctor
```

Reports what is wrong without changing anything, grouped by area:

```text
config.yaml   ok
modes.yaml    ok
packages      ok
sync state    ok
drift         2 problem(s)
  selection changed since the last sync
  precompiled runtime is missing or stale

2 problem(s) found
```

It exits non-zero when any check fails. The configuration sections are strict, so they report the unsupported keys `doompi sync` ignores. When either config file fails to parse, the remaining sections are skipped rather than reported against a composition that could not be resolved.

Use `doompi sync --check` in CI when the question is only whether synchronized state is stale; its output and exit codes are unchanged.

## The web cockpit

```bash
doompi-web [options]
```

| Option                  | Effect                                           |
| ----------------------- | ------------------------------------------------ |
| `--dir <path>`          | Pin, sync, and watch one repository composition. |
| `--registry-dir <path>` | Session registry. Defaults to `~/.doompi/run`.   |
| `--spawn-command <cmd>` | Command used to launch sessions.                 |
| `--port <number>`       | HTTP port. Defaults to `7433`.                   |
| `--host <address>`      | Bind address. Defaults to `127.0.0.1`.           |
| `--assets <path>`       | Override the built SPA directory.                |
| `--state-dir <path>`    | Remote-access and cockpit state directory.       |
| `--cloudflared <path>`  | Explicit `cloudflared` binary.                   |
| `-h`, `--help`          | Print help.                                      |
| `-v`, `--version`       | Print the installed package version.             |

Every option accepts both `--port 7433` and `--port=7433`.

## Troubleshooting and direct use

- Run `doompi doctor` first: it covers configuration, packages, sync state, and drift in one pass.
- Run `doompi sync --check` to identify drift, then `doompi sync` to install missing packages and publish a replacement generation.
- Leader menus require Pi's interactive TUI. Commands and tools may remain available in JSON, RPC, and other headless modes when their package supports those modes.
- Runner tries bundled RMUX, `rmux` on `PATH`, then `tmux` on `PATH`. Without one, non-interactive commands use a supervised subprocess and interactive commands are rejected.
- Install a directly loaded Pi subsystem with `pi install npm:@agimon-ai/<package>`. Library consumers use `npm install`. Do not install native RMUX or RTK packages directly.
- The root `doom-runner` command delegates to Runner from the active repository. If Runner is absent, add `@agimon-ai/doompi-runner` to `modes.yaml`.
