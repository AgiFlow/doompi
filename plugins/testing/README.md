# DoomPi Testing Plugin

This example plugin provides focused testing and read-only code review for Codex, Claude Code, and DoomPi. Both native plugin manifests load the same skills. Hosts that support Markdown agents can also assign work to a dedicated tester or reviewer.

## What it includes

- [`doompi-testing`](skills/doompi-testing/SKILL.md) designs, adds, and runs tests for observable behavior.
- [`doompi-review`](skills/doompi-review/SKILL.md) reviews a change for concrete defects, regressions, missing tests, and contract violations.
- [`doompi-tester`](agents/doompi-tester.md) owns test implementation and verification evidence.
- [`doompi-reviewer`](agents/doompi-reviewer.md) performs review without editing the change.

The plugin uses the target repository's existing tools and conventions. It does not choose a model, language, framework, or test runner.

## Install the plugin directly

Run these commands from the DoomPi repository root. The first command registers the repository's `doompi-examples` marketplace. The second installs `testing` from that marketplace.

Codex:

```bash
codex plugin marketplace add .
codex plugin add testing@doompi-examples
```

Claude Code:

```bash
claude plugin marketplace add ./ --scope user
claude plugin install testing@doompi-examples --scope user
```

The Claude Code commands register and install the plugin for the current user.

## Load it with DoomPi

The repository maps the `testing` domain to this plugin:

```bash
doompi --major-mode copilot --domains testing --explain
doompi --major-mode copilot --domains testing
```

The first command prints the resolved composition and estimated prompt cost without launching Pi. The second launches the Copilot composition with the `testing` domain.

Try `Add focused regression coverage for this bug` for test work, or `Review this diff for concrete regressions` for review.

## Editing boundaries

Testing may add or change tests, but it does not authorize production-code changes. Review is read-only. A separate user request must authorize a production fix or edits during review.
