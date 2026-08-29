# @agimon-ai/doompi-cache

Provider prompt-cache policy and deterministic routing for DoomPi.

DoomPi loads this package as fixed core. It derives stable provider cache keys from the active
session composition and applies them only to supported provider requests. The package can also run
as a standalone [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension.

> **Alpha:** cache routing and provider integration may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.4 for standalone extension use

## Install

A DoomPi installation already includes this package. Do not add it to `.doom/modes.yaml`.

To load it directly in Pi:

```bash
pi install npm:@agimon-ai/doompi-cache
```

Pi reads the extension entry from `package.json.pi.extensions` and loads it after installation.

## Package behavior

DoomPi derives an opaque provider cache key from stable model-visible state: the composition
fingerprint, ordered domains, profile, persona, active minor modes, effective model, and child prompt
projection. Returning to equivalent state restores the same key. Provider expiry or eviction can
still make the cache cold.

The Pi extension rewrites only a nonblank cache key already emitted for an allowlisted OpenAI-family
wire API. It preserves supported retention and provider cache markers, does not add unsupported
fields to proxies, and reports only provider-observed token usage. Telemetry reports current
provider residency as `unknown`.

## Help

The published package includes `llms.txt` and `src/prompts/doompi-use-cache/SKILL.md`. While DoomPi
Help is active, the extension adds `doompi-use-cache` to the live Help catalog. The contribution
follows Help provider replacement and is removed when the extension shuts down.

Help is optional. The standalone Pi extension does not require DoomPi Help or another DoomPi runtime
service.

## Public API

```ts
import {
  createChildPromptCacheProjection,
  createParentPromptCacheNamespace,
  createPromptCacheKey,
  PromptCacheTelemetry,
} from '@agimon-ai/doompi-cache';
import {
  DOOMPI_PROMPT_CACHE_PARENT_NAMESPACE_ENV,
  DOOMPI_PROMPT_CACHE_ROOT_SESSION_ENV,
} from '@agimon-ai/doompi-cache/env';
```

The Pi host entry is `@agimon-ai/doompi-cache/extensions/pi`. Importing the root API does not install
the extension.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm exec vibe-lint check .
npm pack --dry-run
```

The live OpenAI canary is opt-in. It reports provider `cached_tokens`; a cold result does not fail
the test deterministically:

```bash
DOOMPI_CACHE_LIVE_OPENAI=1 \
OPENAI_API_KEY=... \
DOOMPI_CACHE_LIVE_OPENAI_MODEL=... \
pnpm exec vitest run tests/live/openaiPromptCache.live.test.ts
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
