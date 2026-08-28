# DoomPi Blog Writing Plugin

This example plugin takes a blog post from research through editorial review. It works with Codex, Claude Code, and DoomPi without choosing a model, CMS, publication platform, brand voice, or content directory.

## What it includes

- [`blog-research`](skills/blog-research/SKILL.md) creates a research brief and numbered source list. It separates verified facts, inferences, disputed claims, and open questions.
- [`blog-outline`](skills/blog-outline/SKILL.md) turns approved research into a source-aware outline. It does not draft the post.
- [`blog-draft`](skills/blog-draft/SKILL.md) writes a sourced, review-ready draft from the approved outline. It does not publish or update a CMS.
- [`blog-review`](skills/blog-review/SKILL.md) fact-checks and edits the draft, then returns a revision and publication-readiness checklist.

Hosts that support Markdown agents can assign those stages to [`blog-researcher`](agents/blog-researcher.md), [`blog-writer`](agents/blog-writer.md), and [`blog-editor`](agents/blog-editor.md).

## Install the plugin directly

Run these commands from the DoomPi repository root. The first command registers the repository's `doompi-examples` marketplace. The second installs `blog-writing` from that marketplace.

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

The Claude Code commands register and install the plugin for the current user.

## Load it with DoomPi

The repository maps the `blog` domain to this plugin:

```bash
doompi --major-mode copilot --domains blog --explain
doompi --major-mode copilot --domains blog
```

The first command prints the resolved composition and estimated prompt cost without launching Pi. The second launches the Copilot composition with the `blog` domain.

Try: `Research and draft a practical post about this topic for this audience.`

## Output boundaries

The workflow does not publish or write to a CMS. It keeps unsupported claims marked instead of turning them into facts. When `WORKFLOW_RUN_DIR` is set, each skill writes only to its declared artifacts inside that directory. Otherwise, it uses the destination requested by the user.
