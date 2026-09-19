# Development

[Back to DoomPi](../README.md)

Start with the package you are changing. DoomPi is a distribution of packages,
not one application build. Nx follows their dependencies, so a package target
builds what it needs before running its own checks.

```text
package source
     |
     +-- package lint, typecheck, build, test
     |
     +-- architecture preflight
     |
     +-- workspace and example checks
     |
     +-- packed-install system tests for release behavior
```

Run commands from the repository root. [Contributing](../CONTRIBUTING.md) covers
package boundaries, the required checks, commits, and pull requests.

## Local setup

The workspace requires Node.js 22.22.1 or newer. CI uses Node.js 22.22.1 and pnpm
12.3.4, pinned in the [workspace setup action](../.github/actions/setup-monorepo/action.yml).
Use that toolchain to match CI, then install the workspace:

```bash
pnpm install
```

Installation fetches and verifies the pinned Runner native payloads and builds the
repository-owned Vibe-Lint plugins. The root `package.json` declares the Node
minimum; it does not pin pnpm.

## Work on one package

Run the package's four standard targets. For the distribution host:

```bash
pnpm nx lint @agimon-ai/doompi
pnpm nx typecheck @agimon-ai/doompi
pnpm nx build @agimon-ai/doompi
pnpm nx test @agimon-ai/doompi
```

Replace the project name with the package you changed. Before editing governed
files, read their architecture rules with
`pnpm vibe-lint check --rules-only <paths>`. After the change, run
`pnpm lint:vibe --preflight-only`.

Then add the checks that match the change:

- `pnpm examples:check` for plugin, domain, marketplace, or workflow examples
- `pnpm audit:workspace` for dependencies, package metadata, or workspace structure
- `pnpm test:system` for packaging, startup, or release-facing behavior

`pnpm build` builds the whole workspace. Prefer package targets while iterating,
then widen the checks when a change crosses package boundaries.

## Why packed tests are separate

A test can pass in the workspace and still fail after installation. Packed-install
tests create npm tarballs, install them, and exercise the published entry points.
They catch missing resources, wrong export maps, workspace-only imports, and
startup behavior that workspace resolution can hide.

The system suites also check startup paths. CI splits the CLI suites across
runners and keeps execution within each runner serial. Run the local system suite
before a packaging or release-facing change, rather than after every small edit.

## Release architecture

The npm packages belong to the `alpha` release group in [nx.json](../nx.json).
They use independent versions. The group covers the distribution host, fixed core,
selectable features, web packages, Runner payloads, and repository-owned lint
plugins.

Use the release workflow to select projects and keep their package contracts
aligned. Hand-publishing a few packages can leave a consumer with mismatched
manifests, dependencies, or native payloads. Desktop installers have their own
[release workflow](../.github/workflows/desktop-release.yml).

## Maintainer release flow

The release-cut workflow selects the release projects, freezes a candidate, runs
validation, and previews or writes prerelease versions. After its pull request
merges, the publish workflow:

1. freezes the merged commit so each validation job checks the same source;
2. verifies Runner payloads and runs workspace audit, formatting, build, examples,
   lint, architecture preflight, typecheck, unit tests, and packed-install tests;
3. checks packed artifacts and publishes versions missing from npm under `alpha`;
4. reconciles the registry's `alpha` tags and creates Git tags for published versions;
5. promotes those versions to `latest`.

Leave generated changelogs to Nx. For the exact release steps, read the
[release-cut workflow](../.github/workflows/release-cut.yml) and
[publish workflow](../.github/workflows/release-publish.yml).

DoomPi is maintained by [Agimon](https://agimon.ai/about).
