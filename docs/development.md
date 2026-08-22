# Development

[Back to DoomPi](../README.md)

Run these commands from the repository root.

```bash
pnpm install
pnpm build
pnpm examples:check
pnpm nx build @agimon-ai/doompi
pnpm nx test @agimon-ai/doompi
pnpm nx typecheck @agimon-ai/doompi
pnpm nx lint @agimon-ai/doompi
```

DoomPi is maintained by [Agimon](https://agimon.ai/about).

## Maintainer release order

Publish [`@agimon-ai/doompi-extension-contracts`][pkg-doompi-extension-contracts] and
[`@agimon-ai/doompi-hashline`][pkg-doompi-hashline] first, then
[`@agimon-ai/doompi-help`][pkg-doompi-help], and only then the
[`@agimon-ai/doompi`][pkg-doompi] runtime that consumes them. Generated changelogs remain owned
by the release tooling.

The deploy workflow blocks publishing unless the deterministic DoomPi architecture sweep and the
packed-install system tests both pass. This keeps the shared Cordis host contract and independently
loaded extension graph inside the same release boundary as the packages that consume them.

[pkg-doompi]: https://www.npmjs.com/package/@agimon-ai/doompi
[pkg-doompi-hashline]: https://www.npmjs.com/package/@agimon-ai/doompi-hashline
[pkg-doompi-help]: https://www.npmjs.com/package/@agimon-ai/doompi-help
[pkg-doompi-extension-contracts]: https://www.npmjs.com/package/@agimon-ai/doompi-extension-contracts
