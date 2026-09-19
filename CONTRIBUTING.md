# Contributing to DoomPi

Thanks for helping improve DoomPi. It is still alpha, so keep changes focused and
show how you checked them. Small changes are easier to review and safer to release.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

Found a security problem? Keep it out of public issues. Follow
[SECURITY.md](SECURITY.md) to send a private vulnerability report.

## Requirements

Use Node.js 22.22.1 or newer, as required by the workspace `package.json`. To match
CI exactly, use Node.js 22.22.1 and pnpm 12.3.4. Those CI versions live in the
[workspace setup action](.github/actions/setup-monorepo/action.yml).

```bash
pnpm install
```

Run commands in this guide from the repository root.

### Runner native payloads

Runner ships prebuilt RMUX and RTK binaries, but the binaries are not checked into
this repository. During `pnpm install`, `scripts/fetch-runner-binaries.mjs` downloads
them from upstream GitHub releases, checks each file against its pinned SHA-256,
and installs it under the platform package's `vendor/` directory.

The first install downloads missing payloads. Later installs reuse the cache at
`.nx-cache/runner-binaries`.

```bash
pnpm runner:check    # verify what is installed against the pinned checksums
pnpm runner:fetch    # materialize anything missing
```

To move to a new upstream version, update the tag, asset name, and checksums in
`scripts/fetch-runner-binaries.mjs`. `pnpm audit:workspace` reads the same manifest, so the audit
follows automatically.

## Choose the right package

Each package has one job. Put a change where that job belongs:

- The distribution host lives under `packages/cli/*`.
- Shared contracts and libraries live under `packages/core/*`.
- Fixed extension packages live under `packages/foundations/*`.
- Default distribution features live under `packages/default/*`.
- Optional modes live under `packages/minor/*`.
- Standalone client-facing processes live under `packages/clients/*`.
- Shared utilities and prebuilt native payloads live under `packages/utils/*`.
- Selectable extensions live under `layers/<layer>/*`.
- Repository-owned development tools live under `packages/tooling/*`.

Keep Doom-to-Doom dependencies as `workspace:*`. Use published npm versions for
external foundation, MCP, and Vibe-Lint packages. The repository-owned
`@agimon-ai/vibe-lint-plugin-doom-{extension,web,core,cli}` packages also use
`workspace:*`; their implementations live under `packages/tooling/`.

Preserve package exports, Pi entries, resources, runtime ordering, and the Runner
native payload manifest. Read [Architecture](docs/architecture.md) before changing
composition, extension lifecycles, session isolation, or public boundaries. When
public behavior or configuration changes, update the owning package's README too.

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

[CI](.github/workflows/ci.yml) runs on pull requests and pushes to `main`. The
quality job checks Runner payloads, workspace boundaries, formatting, generated
hook settings, builds, examples, lint, architecture rules, types, and unit tests.
Browser and desktop end-to-end jobs exercise the cockpit separately.

Packed-install tests run in CI too, not just after merge. The CLI suites are split
across six runners, with a separate Team suite. Tests within each runner stay
serial because they launch real processes and share local resources. These tests
check installed packages, compatibility, and startup behavior. Run
`pnpm test:system` locally when your change affects packaging or startup.

Every job uses a disposable GitHub-hosted runner, including pull requests from
forks. A first-time contributor's workflow may need maintainer approval before it
starts.

## Commits and pull requests

Use Conventional Commits, with an Nx project name as the scope or `root` and
`release` for repository-wide work. For example:

```text
feat(doompi-edit): reject stale hashline ranges
docs(root): clarify contribution checks
```

Keep each pull request focused. Explain what changes for the user, call out any
configuration or public contract changes, and list the checks you actually ran.
Leave generated changelogs to the release tooling.

## License

Contributions are accepted under the [MIT License](LICENSE).
