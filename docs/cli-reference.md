# CLI reference

[Back to DoomPi](../README.md)

| Command or option                            | What it does                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `dpi init`, `dpi sync`, `dpi`                | Creates, synchronizes, and runs the repository-scoped comparison setup           |
| `doompi init`, `doompi sync`                 | Seeds personal config, builds synchronized state, and registers DoomPi with Pi   |
| `doompi sync --check`                        | Exits non-zero when synchronized state is stale or legacy state needs migration  |
| `doompi compat <codex\|claude\|antigravity>` | Resolves the selected matrix and launches the compatibility adapter              |
| `--skip-permissions`                         | Compat only. Disables the launched frontend's approval prompts for that run      |
| `doom-runner`                                | Inspects and controls supervised Runner processes and logs                       |
| `--explain`                                  | Prints the resolved matrix and estimated prompt cost without launching Pi        |
| `--emit-mcp <dir>`, `--no-mcp`               | Writes the resolved MCP config or disables MCP for one run                       |
| `--cwd <path>`, `--auto-stop`                | Chooses the working directory or exits after an interactive agent settles        |
| `--sandbox`                                  | Runs the whole session in a container, terminal attached; accepted by `dpi` too  |
| `--` and remaining arguments                 | Forwards provider or Pi arguments unchanged where the selected command allows it |

`doompi compat` leaves the third-party frontend's own approval behavior alone unless you pass
`--skip-permissions`, which maps to `--dangerously-skip-permissions` for Claude and Antigravity and
to `--yolo` for Codex. Runs that bypass print a warning to stderr. See
[Trust and data boundaries](trust-and-data-boundaries.md#approval-prompts-in-compatibility-mode).

## Troubleshooting and direct use

- Run `doompi sync --check` to detect drift or missing configured packages, and `doompi sync`
  to install them and rebuild synchronized state.
- If RMUX is unavailable on a supported target, Runner reports the fallback it uses. Linux native
  artifacts require a compatible loader and libc environment.
- Leader menus and overlays require Pi's interactive TUI. Commands and tools remain the interface
  for JSON, RPC, and other headless sessions where the owning package supports them.
- Install a directly loaded Pi subsystem with `pi install npm:@agimon-ai/<package>`. Library consumers
  use `npm install`; native RMUX artifacts are selected by Runner and should not be installed directly.
  The root `doom-runner` command delegates to Runner from the active repository and asks you to add
  Runner to `modes.yaml` when it is absent. The distribution remains the supported way to get the
  coordinated defaults.
