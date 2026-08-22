---
name: doompi-development
description: Implement scoped code changes in an existing repository and verify them with its native checks. Use when the user asks to build, change, or fix code, not for a review-only request.
---

# Scoped Development

Deliver the smallest coherent change that satisfies the request and fits the repository.

## Before changing code

- Read the applicable repository instructions and inspect the current worktree.
- Identify the requested behavior, acceptance evidence, and files that own the behavior.
- Reuse nearby patterns and public interfaces before adding a new abstraction.
- Ask only when a missing product or architecture choice would materially change the result.

## Implement

- Keep edits within the requested scope and preserve unrelated user changes.
- Follow existing naming, dependency, error-handling, and testing conventions.
- Update tests or documentation only when the behavior change requires them.
- Treat generated files, migrations, dependency changes, and external writes as separate actions that need clear authorization.

## Verify

- Run the narrowest relevant checks first, then the repository-required lint, typecheck, build, and test commands.
- Inspect failures instead of hiding, weakening, or bypassing them.
- Report which behavior was verified, which commands ran, and any remaining uncertainty.

Do not create branches, commits, releases, or pull requests unless the user requests them.
