# DoomPi Testing Plugin

This example packages focused testing and evidence-based code review for Codex, Claude Code, and
DoomPi. The Codex and Claude Code manifests load the same skills, while hosts that support Markdown
agents can also route work to a tester or reviewer.

## Components

- [`doompi-testing`](skills/doompi-testing/SKILL.md) designs, implements, and runs behavior-focused tests.
- [`doompi-review`](skills/doompi-review/SKILL.md) reviews changes for concrete defects and regressions.
- [`doompi-tester`](agents/doompi-tester.md) owns test evidence.
- [`doompi-reviewer`](agents/doompi-reviewer.md) owns read-only code review.

The plugin uses the repository's existing test tools and conventions. It does not pin a model,
language, framework, or runner.

## Install directly

Register the repository marketplace once from the repository root, then install the plugin.

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

## Compose with DoomPi

```bash
doompi --major-mode copilot --domains testing --explain
doompi --major-mode copilot --domains testing
```

Try `Add focused regression coverage for this bug` for testing, or
`Review this diff for concrete regressions` for a read-only review.

Testing may edit tests, but it does not authorize production-code changes. Review remains read-only
unless the user separately requests a fix.
