## What this changes

<!-- One or two sentences. What behaviour is different after this merges? -->

## Why

<!-- The problem being solved. Link the issue if there is one: Closes #123 -->

## Checks

Run these locally before asking for review. CI runs the same set.

- [ ] `pnpm lint:vibe --preflight-only`
- [ ] Affected Nx targets pass: `lint`, `typecheck`, `build`, `test`
- [ ] `pnpm fmt:check`
- [ ] Packed-install system tests, if this is a release change: `pnpm nx run-many -t test-system`

## Scope

- [ ] Package boundaries are respected (`packages/core`, `packages/default`, `packages/minor`, `packages/clients`, `layers/`, `packages/tooling`)
- [ ] Doom-to-Doom dependencies stay `workspace:*`
- [ ] Package exports, Pi entries, resources, runtime ordering, and RMUX LFS payloads are preserved
- [ ] No unrelated changes bundled in

## Risk

<!--
Anything a reviewer should look at twice: a new dependency, a change to the
release workflows, anything that runs on the self-hosted runner, a change to
what DoomPi executes on a user's machine, or a change to the trust boundary
documented in docs/trust-and-data-boundaries.md. Write "none" if there is none.
-->
