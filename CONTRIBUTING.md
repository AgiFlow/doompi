# Contributing to DoomPi

Thanks for helping improve DoomPi. The project is still alpha, so focused changes with clear tests
are easier to review and safer to release.

By participating in this project you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security problem? Do not open a public issue. Follow [SECURITY.md](SECURITY.md) and use
GitHub's private vulnerability reporting, which keeps the report visible only to the maintainers.

## Requirements

- Node.js 22.22.1
- pnpm 11.1.3

```bash
pnpm install
```

Run commands in this guide from the repository root.

### Runner native payloads

Runner ships prebuilt RMUX and RTK binaries. They are not stored in this repository: `pnpm install`
runs `scripts/fetch-runner-binaries.mjs`, which downloads them from the upstream GitHub releases and
verifies every file against a pinned SHA-256 before installing it under each platform package's
`vendor/` directory.

That is roughly 156 MB on a cold cache, downloaded once and reused from `.nx-cache/runner-binaries`.

```bash
pnpm runner:check    # verify what is installed against the pinned checksums
pnpm runner:fetch    # materialize anything missing
```

To move to a new upstream version, update the tag, asset name, and checksums in
`scripts/fetch-runner-binaries.mjs`. `pnpm audit:workspace` reads the same manifest, so the audit
follows automatically.

## Choose the right package

DoomPi is a monorepo with deliberate package boundaries:

- Runtime foundations live under `packages/core/*`.
- Default distribution features live under `packages/default/*`.
- Optional modes live under `packages/minor/*`.
- Selectable extensions live under `layers/<layer>/*`.
- Repository-owned development tools live under `packages/tooling/*`.

Keep Doom-to-Doom dependencies as `workspace:*`. Use published npm versions for external
foundation, MCP, and Vibe-Lint packages. Preserve package exports, Pi entries, resources, runtime
ordering, and the Runner native payload manifest. The repository-owned
`@agimon-ai/vibe-lint-plugin-doom-extension` package is the tooling exception and uses `workspace:*`.

Read [Architecture](docs/architecture.md) before changing package composition, extension lifecycle,
session isolation, or public boundaries. Update the owning package README when public behavior or
configuration changes.

## Make and verify a change

Before editing governed files, inspect the rules that apply to them:

```bash
pnpm vibe-lint check --rules-only <paths>
```

After the change, format the files you touched and run the deterministic architecture preflight:

```bash
pnpm exec oxfmt <paths>
pnpm lint:vibe --preflight-only
```

Run lint, type-check, build, and test for every affected Nx project. Replace the project name below
with the package you changed:

```bash
pnpm nx lint @agimon-ai/doompi-edit
pnpm nx typecheck @agimon-ai/doompi-edit
pnpm nx build @agimon-ai/doompi-edit
pnpm nx test @agimon-ai/doompi-edit
```

Run the additional checks that match the change:

- `pnpm examples:check` for example plugins, domains, marketplaces, or workflows.
- `pnpm audit:workspace` for dependencies, package metadata, or workspace structure.
- `pnpm test:system` for release-affecting changes that need packed-install and runtime coverage.

On a pull request, CI runs formatting, the workspace audit, generated hook settings, builds, examples,
lint, Vibe-Lint, type-checking, and unit tests on a GitHub-hosted runner.

Pull requests from forks always run on a GitHub-hosted runner, never on the project's self-hosted
machine. If this is your first contribution, a maintainer has to approve the workflow run before CI
starts, so expect a delay before any results appear.

The serial packed-install system tests run after merge, on push to `main`. They pack and install all
40 packages for real and assert startup latency percentiles, which are not meaningful on a shared
runner. Run `pnpm test:system` locally when a change affects packaging or startup.

## Commits and pull requests

Commit messages follow Conventional Commits. Use an Nx project name as the scope, or `root` and
`release` for repository-wide work. For example:

```text
feat(doompi-edit): reject stale hashline ranges
docs(root): clarify contribution checks
```

Keep each pull request focused. Explain the user-visible outcome, call out configuration or public
contract changes, and list the checks you ran. Leave generated changelogs to the release tooling.

## License

Contributions are accepted under the [MIT License](LICENSE).
