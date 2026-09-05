# Development

[Back to DoomPi](../README.md)

Run these commands from the repository root:

```bash
pnpm install
pnpm build
pnpm examples:check
pnpm nx build @agimon-ai/doompi
pnpm nx test @agimon-ai/doompi
pnpm nx typecheck @agimon-ai/doompi
pnpm nx lint @agimon-ai/doompi
```

`pnpm build` builds every workspace project through Nx. The four targeted commands then build, test, type-check, and lint the root runtime package.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for repository boundaries, required checks, commit rules, and pull-request guidance.

## Maintainer release flow

DoomPi uses the independent `alpha` release group in `nx.json`. Do not hand-publish a short package subset: the group includes the root runtime, fixed core, selectable features, clients, native Runner payloads, web packages, and repository-owned lint plugins. Workspace dependencies determine the build graph, and the release workflow publishes the selected versions under the `alpha` tag.

The release-cut workflow selects affected release projects, runs the full candidate validation, and previews or writes the prerelease versions. After the release pull request merges, the publish workflow:

1. verifies Runner payloads;
2. runs the workspace audit, formatting check, build, examples check, lint, architecture preflight, typecheck, tests, and packed-install system tests;
3. publishes versions missing from npm under `alpha` with `pnpm nx release publish`;
4. waits for every release version to appear under `alpha`, then creates its Git tag; and
5. promotes the published versions to `latest`.

Generated changelogs remain owned by Nx release tooling. See the [release-cut workflow](../.github/workflows/release-cut.yml) and [publish workflow](../.github/workflows/release-publish.yml) for the executable contract.

DoomPi is maintained by [Agimon](https://agimon.ai/about).
