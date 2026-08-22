import { createRequire } from 'node:module';

// createRequire rather than a JSON import: this file runs both from src under
// Node's strip-only TypeScript mode (how pi.sh starts it) and from dist. The
// package self-reference resolves the same published manifest from either tree.
const require = createRequire(import.meta.url);
const PACKAGE_MANIFEST = '@agimon-ai/doompi/package.json';

export const HARNESS_VERSION = (require(PACKAGE_MANIFEST) as { version: string }).version;

export function printHelp(): void {
  process.stdout.write(`doompi

Usage: doompi [harness options] [Pi options] [prompt]
       doompi init
       doompi sync [matrix options] [--check]
       doompi compat <codex|claude|antigravity> [matrix options] [provider arguments]

Initialization:
  doompi init              Fill missing files in ~/.pi/.doom
  doompi sync              Update packages, build, resolve, and register DoomPi
                            in Pi user settings
  doompi sync --check      Exit non-zero when the synced config is out of date
                            or report legacy repository-local state to migrate

Sync artifacts live under ~/.pi/.doom/sync in a repository- and worktree-specific
namespace. Linked worktrees isolate state, dist, manifests, resources, and run
files while sharing immutable repository build objects. A legacy <repo>/.pi/doom
state is read only when no global state exists; run doompi sync to migrate it.
DoomPi never removes old or orphaned generated directories automatically.

After a sync, run pi directly. The synced session accepts --major-mode,
--domains, --profile, and --mute, and /mode, /domains, and /profile switch
without a restart. Selection defaults come from the selection block in
.doom/config.yaml.

Compatibility matrix options:
  --profile <name>          Persona and env from .doom/profiles.yaml
  --domains <names>         Comma-separated content domains
  --major-mode <name>       Named major mode from .doom/modes.yaml
  --skip-permissions        Disable the launched frontend's approval prompts
                            for this run. Off by default; the run warns when on.
  --                        Pass following matrix-named flags to the provider

All other compatibility arguments pass to the provider unchanged.

Harness options:
  --major-mode <name>       Named major mode from .doom/modes.yaml
                            (default: copilot). Not --mode: Pi owns that one.
  --profile <name>          Persona and env from .doom/profiles.yaml
  --domains <names>         Comma-separated domains (content: plugins, skills)
  --no-domains              Load no content domains
  --explain                 Print the resolved matrix and exit
  --emit-mcp <dir>          Write the resolved MCP config to a directory and exit
  --plugin-dir <path>       Load an explicit plugin directory, repeatable
  --add-dir <path>          Add an accessible directory, repeatable
  --preset <name>           default, kimi, or ollama
  --cwd <path>              Run Pi in this directory
  --automation              Use print mode, JSON output, and project approval
  --output-format vibe-lint Read a vibe-lint request from stdin and emit one JSON response
  --mute                    Disable the notification extension for this run
  --auto-stop               Exit interactive Pi when the agent settles
  --allow-protected-writes  Allow writes to protected repository paths
  --hooks, --no-hooks       Enable or disable repository and plugin hooks
  --mcp, --no-mcp           Enable or disable MCP configuration
  --agents, --no-agents     Enable or disable spawnable agents
  -h, --help                Show harness help
  -v, --version             Show harness version

Interactive commands:
  /loop                     Open the loop launcher picker
  /loops                    List active loops and stop future scheduling
  /effort <level>           Set and persist the thinking effort
  /mode                     Pick a named major mode
  /domains [names]          Show the selected domains or pick a different set
  /profile                  List or switch persona and environment profiles

Minor modes are toggled from the Leader menu, not by a slash command:
  SPC p e                   Plan mode (repository read-only)
  SPC w e                   Workflow tools for the agent

All remaining options are passed to Pi.
`);
}
