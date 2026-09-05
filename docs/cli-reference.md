# CLI reference

[Back to DoomPi](../README.md)

## Setup commands

| Command               | Effect                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dpi init`            | Creates missing `.doom` files in the current repository. It does not change Pi settings.                                                                                                                    |
| `dpi init --force`    | Replaces the repository's four `.doom` files with the current templates.                                                                                                                                    |
| `dpi sync`            | Installs required configured packages, builds synchronized state, and prepares an in-memory Pi settings overlay. It does not persist that overlay.                                                          |
| `dpi`                 | Runs the pinned Pi version with the synchronized DoomPi overlay. Other arguments pass to Pi, except `--sandbox`, which DoomPi handles.                                                                      |
| `doompi init`         | Creates missing files in `~/.pi/.doom`, writes the DoomPi extension alias and theme, and registers both in Pi user settings.                                                                                |
| `doompi init --force` | Replaces the four personal `.doom` files, then refreshes the Pi integration resources.                                                                                                                      |
| `doompi sync`         | Installs required configured packages and publishes synchronized state. Requires the user integration created by `doompi init`; reconciles existing repository Pi settings without rewriting user settings. |
| `doompi sync --check` | Checks package resolution, configuration drift, synchronized artifacts, the alias, the theme, and Pi settings without writing. It exits non-zero when anything is stale or legacy state needs migration.    |

Both sync commands accept the matrix options below. Generated state lives under `~/.pi/.doom/sync` in a repository- and worktree-specific namespace. After publication, sync retains one superseded generation and attempts to remove older generations. Cleanup failures are reported without failing the published sync.

## Compatibility mode

```bash
doompi compat <codex|claude|antigravity> [matrix options] [provider arguments]
```

Compatibility mode resolves the selected DoomPi matrix, then launches the named frontend. It consumes `--major-mode`, `--domains`, `--domain`, `--profile`, and `--skip-permissions`. Other arguments pass through unchanged. Put `--` before a provider-native option whose name collides with a DoomPi matrix option.

`--skip-permissions` disables the frontend's approval prompts for that run. It maps to `--dangerously-skip-permissions` for Claude and Antigravity, and `--yolo` for Codex. DoomPi prints a warning to stderr whenever it enables a bypass. See [Approval prompts in compatibility mode](trust-and-data-boundaries.md#approval-prompts-in-compatibility-mode).

## Launch options

| Option                      | Effect                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--major-mode <name>`       | Selects one major mode from `.doom/modes.yaml`.                                                                                           |
| `--domains <names>`         | Selects comma-separated content domains. `--domain` is also accepted.                                                                     |
| `--no-domains`              | Loads no content domains. It cannot be combined with `--domains`.                                                                         |
| `--profile <name>`          | Selects a persona and environment profile.                                                                                                |
| `--explain`                 | Resolves the matrix, prints its contents and estimated prompt cost, then exits. MCP schema inspection may start configured stdio servers. |
| `--emit-mcp <dir>`          | Writes the resolved MCP configuration to a directory, then exits. MCP must be enabled.                                                    |
| `--mcp`, `--no-mcp`         | Enables or disables MCP configuration for this run. Use `--no-mcp` with `--explain` to avoid starting MCP servers.                        |
| `--agents`, `--no-agents`   | Enables or disables spawnable agent resources.                                                                                            |
| `--hooks`, `--no-hooks`     | Enables or disables repository and plugin hooks.                                                                                          |
| `--plugin-dir <path>`       | Loads an explicit plugin directory. Repeat the option to load more than one.                                                              |
| `--add-dir <path>`          | Adds an accessible directory. Repeat the option to add more than one.                                                                     |
| `--cwd <path>`              | Runs Pi in that directory. `--cd` is also accepted.                                                                                       |
| `--preset <name>`           | Selects `default`, `kimi`, or `ollama` provider normalization.                                                                            |
| `--automation`              | Adds Pi print mode, JSON output, and project approval unless already supplied.                                                            |
| `--auto-stop`               | Exits an interactive Pi session after the agent settles. It is rejected in print and JSON modes.                                          |
| `--sandbox`                 | Runs the session through the sandbox harness exported by a selected layer. `dpi` accepts this option too.                                 |
| `--allow-protected-writes`  | Allows writes to repository paths that DoomPi otherwise protects.                                                                         |
| `--mute`                    | Disables DoomPi notifications for this run.                                                                                               |
| `--output-format vibe-lint` | Reads one vibe-lint request from stdin and writes one JSON response.                                                                      |
| `-h`, `--help`              | Prints DoomPi harness help without resolving the repository.                                                                              |
| `-v`, `--version`           | Prints the DoomPi package version.                                                                                                        |

DoomPi forwards remaining launch arguments to Pi. `--explain` is not a no-execution security boundary: it starts each allowed stdio MCP server when it must inspect tool schemas. See [Executable inputs](trust-and-data-boundaries.md#executable-inputs).

## Troubleshooting and direct use

- Run `doompi sync --check` to identify drift or missing configured packages. Run `doompi sync` to install required packages and rebuild state.
- Runner tries bundled RMUX, `rmux` on `PATH`, then `tmux` on `PATH`. If none is available, non-interactive commands use a supervised subprocess and interactive commands are rejected. Linux native artifacts require a compatible loader and libc environment.
- Leader menus and overlays require Pi's interactive TUI. Commands and tools remain available in JSON, RPC, and other headless sessions when the owning package supports them.
- Install a directly loaded Pi subsystem with `pi install npm:@agimon-ai/<package>`. Library consumers use `npm install`. Do not install native RMUX or RTK packages directly.
- The root `doom-runner` command delegates to Runner from the active repository. If Runner is not selected, it asks you to add `@agimon-ai/doompi-runner` to `modes.yaml`.
