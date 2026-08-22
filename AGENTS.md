# AGENTS.md

- Ask, dont assume. If something's unclear, ask before writing a line and no silent guesses about intent, architecture, or requirements. Verbs like review, audit, check, improve, look at are ambiguous by default: confirm the scope (source code, rendered UI, design-system compliance) before starting.
- Simplest solution first and implement the minimum thing that works. No abstractions you didn't request.
- Fix issues in files you are already touching for the current task. For issues elsewhere, report them instead of fixing; don't expand scope silently.
- Flag uncertainty explicitly or if you're not confident, say so before proceeding as confidence without certainty causes more damage than admitting a gap.
- Separate verified from inferred in every report. Reading source is not running it and not seeing it rendered. Never state an inference in the voice of an observation: mark it unverified or cut it.
- When challenged on one part of your work, re-check the whole approach against these rules, not just the point raised.
- DO NOT automatically checkout new branch if not asked.

## Operation Phylosophy

- Think in weeks.
- Optimize for profit, growth and sustainability.
- Reliability over cleverness.
- Fast iteration over perfect planning.
- Distribution is non-negotiable.
- Reasoning is scarce. Spend it wisely.
- Data is durable. Models are replaceable.
- Reuse before rebuilding.
- Challenge assumptions with evidence.
- Measure outcomes, not output.

## Writing Style

- NEVER use em-dashes in any writing you produce: marketing content, articles, captions, scripts, briefs, UI copy, docs, commit messages. Em-dashes are an AI-writing tell. Use a comma, colon, period, or parentheses instead.

## Boundaries

- Runtime foundations live under `packages/core/*`, default distribution features under `packages/default/*`, optional modes under `packages/minor/*`, selectable extensions under `layers/<layer>/*`, and repository-owned development tools under `packages/tooling/*`.
- Keep Doom-to-Doom dependencies as `workspace:*`.
- Use published npm versions for `@agimon-ai/vibe-lint`, MCP, and foundation packages. The repository-owned `@agimon-ai/vibe-lint-plugin-doom-extension` is the tooling exception and is consumed with `workspace:*`.
- Preserve package exports, Pi entries, resources, runtime ordering, and RMUX LFS payloads.

## Required workflow

1. Run `pnpm vibe-lint check --rules-only <paths>` before editing governed files.
2. Run `pnpm lint:vibe --preflight-only` after changes.
3. Run the affected Nx lint, typecheck, build, and test targets.
4. Run packed-install system tests before any release change.
