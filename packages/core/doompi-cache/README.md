# @agimon-ai/doompi-cache

Provider prompt cache policy and deterministic routing for DoomPi

This package is a composable [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) subsystem. Use it with the distribution or install it independently in [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

## Requirements

- Node.js 22.19.0 or newer
- `@earendil-works/pi-coding-agent` 0.84.3

## Install

```bash
pi install npm:@agimon-ai/doompi-cache
```

The package declares its Pi extension entry, so Pi loads it after installation. DoomPi users can include the package through their normal profile and domain composition instead.

## Package behavior

DoomPi derives an opaque provider cache key from stable model-visible state, including the composition fingerprint, ordered domains, profile, persona, active minor modes, effective model, and child prompt projection. Returning to equivalent state restores the same key, but provider expiry or eviction can still make that namespace cold.

The Pi extension rewrites only a nonblank cache key already emitted for an allowlisted OpenAI-family wire API. It preserves supported retention and provider cache markers, avoids adding unsupported fields to proxies, and reports only provider-observed token usage. Telemetry always reports current provider residency as `unknown`.

## Help

The published package includes `llms.txt` and the package-owned `src/prompts/doompi-use-cache/SKILL.md`. When the DoomPi Help minor mode is active, the extension contributes `doompi-use-cache` to its live Help catalog. The contribution follows Help provider replacement and is withdrawn when the extension shuts down.

Help remains optional. Loading the standalone Pi extension does not require DoomPi Help or any other DoomPi runtime service.

To add another package-owned Help prompt, use the `scaffold-doom-prompt` feature with a `doompi-author-*` or `doompi-use-*` name and a concise description. Then link the generated `SKILL.md` from `llms.txt` and register a matching descriptor through the optional `DOOM_HELP_SERVICE` injection in the Pi adapter. Keep prompts as published resources under `src/prompts`; do not export them or copy them into `dist`.

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

The Pi host entry is available at `@agimon-ai/doompi-cache/extensions/pi`. The root API has no import-time extension side effects.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm exec vibe-lint check .
npm pack --dry-run
```

The official OpenAI canary is opt-in and reports provider `cached_tokens` without treating a cold result as a deterministic failure:

```bash
DOOMPI_CACHE_LIVE_OPENAI=1 \
OPENAI_API_KEY=... \
DOOMPI_CACHE_LIVE_OPENAI_MODEL=... \
pnpm exec vitest run tests/live/openaiPromptCache.live.test.ts
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
