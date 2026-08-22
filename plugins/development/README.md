# DoomPi Development Plugin

This example packages a portable development workflow for Codex, Claude Code, and DoomPi. It
demonstrates how native plugin manifests can share one skills directory instead of maintaining
vendor-specific prompt copies.

## Components

- [`doompi-development`](skills/doompi-development/SKILL.md) guides scoped implementation and verification.
- [`doompi-developer`](agents/doompi-developer.md) is the corresponding implementation agent for
  hosts that support Markdown agents.
- `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` expose the same `skills/` directory.

The plugin does not pin a model, framework, package manager, or test runner. It discovers and
follows the target repository's own instructions.

## Install directly

Register the repository marketplace once from the repository root, then install the plugin.

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

## Compose with DoomPi

The repository's DoomPi domain configuration selects this plugin as `development`:

```bash
doompi --major-mode copilot --domains development --explain
doompi --major-mode copilot --domains development
```

Try a request such as: `Implement the smallest safe version of this feature and verify it.`

The plugin never creates a branch, commit, release, or pull request unless the user asks for that
action.
