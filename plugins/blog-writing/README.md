# DoomPi Blog Writing Plugin

This example turns a topic into a source-backed, review-ready blog post through separate research,
outline, drafting, and editorial stages. It demonstrates that DoomPi can compose non-code work with
the same native plugin conventions used for development.

## Components

- [`blog-research`](skills/blog-research/SKILL.md) produces a traceable research brief and source list.
- [`blog-outline`](skills/blog-outline/SKILL.md) turns approved research into a focused structure.
- [`blog-draft`](skills/blog-draft/SKILL.md) writes a sourced draft without publishing it.
- [`blog-review`](skills/blog-review/SKILL.md) fact-checks and edits the draft.
- On hosts that support Markdown agents,
  [`blog-researcher`](agents/blog-researcher.md), [`blog-writer`](agents/blog-writer.md), and
  [`blog-editor`](agents/blog-editor.md) provide clear stage ownership.

The plugin does not pin a model, publication platform, CMS, brand voice, or content directory. The
user or workflow supplies those choices when they matter.

## Install directly

Register the repository marketplace once from the repository root, then install the plugin.

Codex:

```bash
codex plugin marketplace add .
codex plugin add blog-writing@doompi-examples
```

Claude Code:

```bash
claude plugin marketplace add ./ --scope user
claude plugin install blog-writing@doompi-examples --scope user
```

## Compose with DoomPi

```bash
doompi --major-mode copilot --domains blog --explain
doompi --major-mode copilot --domains blog
```

Try: `Research and draft a practical post about this topic for this audience.`

Research must remain traceable, unsupported claims stay marked, and no stage publishes or writes to
a CMS. When a workflow run directory is supplied, the skills write only to declared artifacts
inside it.
