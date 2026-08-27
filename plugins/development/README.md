# DoomPi Development Plugin

This example plugin provides one portable implementation workflow for Codex, Claude Code, and DoomPi. Both native plugin manifests load the same skill instead of maintaining host-specific prompt copies.

## What it includes

- [`doompi-development`](skills/doompi-development/SKILL.md) scopes a requested code change, implements the smallest coherent solution, and verifies it with the target repository's own checks.
- [`doompi-developer`](agents/doompi-developer.md) provides the corresponding implementation agent on hosts that support Markdown agents.
- `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` expose the shared `skills/` directory to their respective hosts.

The plugin does not choose a model, framework, package manager, or test runner. It reads and follows the target repository's instructions and existing conventions.

## Install the plugin directly

Run these commands from the DoomPi repository root. The first command registers the repository's `doompi-examples` marketplace. The second installs `development` from that marketplace.

Codex:

```bash
codex plugin marketplace add .
codex plugin add development@doompi-examples
```

Claude Code:

```bash
claude plugin marketplace add ./ --scope user
claude plugin install development@doompi-examples --scope user
```

The Claude Code commands register and install the plugin for the current user.

## Load it with DoomPi

The repository maps the `development` domain to this plugin:

```bash
doompi --major-mode copilot --domains development --explain
doompi --major-mode copilot --domains development
```

The first command prints the resolved composition and estimated prompt cost without launching Pi. The second launches the Copilot composition with the `development` domain.

Try: `Implement the smallest safe version of this feature and verify it.`

## Operational boundaries

The workflow preserves unrelated worktree changes and avoids new dependencies or abstractions unless the task requires them. It does not create a branch, commit, release, or pull request unless the user explicitly requests that action.
