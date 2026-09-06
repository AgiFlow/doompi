# Development

[Back to DoomPi](../README.md)

DoomPi is a package graph, not one application build. Nx owns that graph: a package target builds its dependencies first, while repository-wide targets validate the complete distribution.

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

Run commands from the repository root. See [CONTRIBUTING.md](../CONTRIBUTING.md) for package boundaries, the required workflow, commit rules, and pull-request guidance.

## Local setup

```bash
pnpm install
```

Node.js and pnpm versions are pinned in the root package metadata. Installation also materializes the pinned Runner native payloads and builds the repository-owned Vibe-Lint plugins.

## Work on one package

Run the package's four standard targets:

```bash
pnpm nx lint @agimon-ai/doompi
pnpm nx typecheck @agimon-ai/doompi
pnpm nx build @agimon-ai/doompi
pnpm nx test @agimon-ai/doompi
```

Replace the project name with the package being changed. Before editing governed files, inspect their architecture rules with `pnpm vibe-lint check --rules-only <paths>`. After the change, run `pnpm lint:vibe --preflight-only`.

Use the extra check that matches the contract being changed:

- `pnpm examples:check` for plugin, domain, marketplace, or workflow examples
- `pnpm audit:workspace` for dependencies, package metadata, or workspace structure
- `pnpm test:system` for packaging, startup, or release-facing behavior

`pnpm build` builds the complete workspace through Nx. Prefer the affected package targets during iteration, then widen validation when the change crosses package boundaries.

## Why packed tests are separate

Unit tests run against workspace source and built dependencies. Packed-install tests create npm tarballs, install the packages, and exercise the published entry points. They catch missing resources, incorrect export maps, workspace-only imports, and startup behavior that ordinary workspace resolution can hide.

The serial system suite also measures startup paths. Run it before a release-affecting change rather than on every small edit.

## Release architecture

DoomPi uses one independent `alpha` release group in `nx.json`. The group includes the root runtime, fixed core, selectable features, clients, web packages, Runner native payloads, and repository-owned lint plugins.

The group is released together because a consumer composition crosses those package boundaries. Hand-publishing a short subset can leave synchronized manifests, workspace contracts, or native payload versions inconsistent.

## Maintainer release flow

The release-cut workflow selects affected release projects, runs candidate validation, and previews or writes prerelease versions. After its pull request merges, the publish workflow:

1. verifies Runner payloads;
2. runs workspace audit, formatting, build, examples, lint, architecture preflight, typecheck, unit tests, and packed-install system tests;
3. publishes npm versions that do not yet exist under the `alpha` tag;
4. waits for each version to become visible, then creates its Git tag; and
5. promotes the published versions to `latest`.

Generated changelogs belong to Nx release tooling. The executable contract lives in the [release-cut workflow](../.github/workflows/release-cut.yml) and [publish workflow](../.github/workflows/release-publish.yml).

DoomPi is maintained by [Agimon](https://agimon.ai/about).
