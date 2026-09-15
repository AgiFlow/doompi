---
name: doompi-author-skill
description: Author and distribute DoomPi agent skills. Use when creating a SKILL.md, adding supporting references or scripts, contributing a runtime skill directory through Cordis, or publishing activation-gated Help prompts from a DoomPi package.
---

# Author DoomPi skills

Create one focused skill per directory. Name the directory with lowercase letters, digits, and hyphens, and give it a required `SKILL.md`:

```markdown
---
name: repository-review
description: Review repository changes when the user asks for implementation-risk and regression analysis.
---

# Repository review

Put the essential workflow and non-obvious constraints here.
```

The frontmatter `name` must match the directory. Make the description specific enough for automatic routing. Keep the entrypoint concise, and put substantial conditional details in linked `references/`. Add `scripts/`, `assets/`, or `agents/` only when the skill actually uses them.

## Choose the distribution path

- For a normal Pi skill that should be discoverable whenever its owning extension is active, ship the skill under a package-owned runtime directory such as `skills/<name>/SKILL.md`. Register that directory through `DOOM_SKILL_SOURCES_SERVICE` inside an owning `cordis.inject(...)`, and return the contribution disposer.
- For guidance that should appear only while DoomPi Help is active, put it at `src/prompts/<name>/SKILL.md`, publish `src/prompts`, link it from the package's H1-led `llms.txt`, and register a Help descriptor through `DOOM_HELP_SERVICE`.
- For repository content selected by domains, place the skill in the plugin or shared skill source configured by `domains.yaml`; do not hard-code that directory into the Skill package.

Help descriptors carry only `name` and `description`. The Help service resolves the owning package from the contribution's exact package `source` and `moduleUrl`, then wraps its `llms.txt`. Keep every index link inside the published package.

## Verification

Validate the skill frontmatter, ensure every relative reference resolves, and test the packed package rather than relying on checkout-only files. For Cordis contributions, cover late provider arrival, provider replacement, withdrawal, and package shutdown. Use `/skills` or `SPC e s` in an interactive session to confirm the expected owner and invocation name.
