# @agimon-ai/doompi-extension-contracts

Validated payloads, named Cordis services, and lifecycle contracts shared by DoomPi extensions.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

This is a library, not a Pi extension: it has no Pi manifest and nothing to add to a DoomPi layer.
It declares Pi as an optional peer for the host bridge types. Extension authors install it when
contributing to shared DoomPi surfaces.

> **Alpha:** service and event contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer

## Install

```bash
npm install @agimon-ai/doompi-extension-contracts
```

## Contract map

Focused subpaths define ownership boundaries. Use `/protocol` only for genuine process or transport
boundaries; same-runner extensions collaborate through the named Cordis services and events below.

| Subpath                                 | Contract                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `/protocol`                             | Runtime creation, request/reply, notification, job, validation, and protocol errors |
| `/cordis-host`                          | Versioned host discovery, runtime/session services, and standalone fallback         |
| `/mode`                                 | `doom/minor-mode-catalog` registration, snapshots, and owner-routed actions         |
| `/ui-hub`, `/leader`, `/footer`         | `doom/ui-hub` aggregation and typed UI contribution values                          |
| `/help`                                 | `doom/help` contributions and active-skill snapshots                                |
| `/skills`, `/loop-launchers`            | Provider-owned registries for skill directories and recurring-loop launchers        |
| `/voice-tools`, `/narration`            | `doom/voice-tools` registration and `doom/narration` requests                       |
| `/notification`                         | Versioned `doom/notification` requests and `doom-notification` session entry data   |
| `/ask-user`                             | Typed `doom/ask-user/*` fan-out events                                              |
| `/voice-reload-handoff`                 | Generation- and TTL-fenced Voice reload handoff state                               |
| `/background-work`, `/delegation`       | Team-owned Cordis services and events for background/delegated work                 |
| `/subagent-policy`, `/subagent-tool`    | Team-owned policy service and tool boundaries                                       |
| `/mcp-projection`                       | Immutable, session-scoped MCP configuration projection over Cordis                  |
| `/readiness`                            | Generation-safe package initialization and Cordis service coordination              |
| `/config`, `/mcp-status`, `/transition` | Other shared DoomPi service and transition-coordination surfaces                    |
| `/child-process`, `/fable-plan`         | Process-role and Team-owned Fable service contracts                                 |
| `/context-contributions`                | Session-scoped broker for bounded, provider-rendered context                        |
| `/tool-overrides`                       | Runtime-scoped ownership registry for Pi tool replacements                          |
| `/mcp-session`                          | Validated MCP session documents for child-process boundaries                        |
| `/mcp-tool-resolver`                    | Session-scoped resolution of MCP selectors to registered Pi tools                   |

Schemas validate data at package boundaries. Notification callers submit bounded `body` text with
optional `title`, `subtitle`, and `info`, `warning`, or `error` level. Providers publish normalized
version 1 entry data with every field present under the `doom-notification` entry type. Live
collaboration providers are mounted in Cordis plugin fibers; consumers use `ctx.inject(...)`, so
provider unload and replacement automatically retract and rebind their handles.

## Example: contribute a Leader binding

```ts
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';

export function reviewPlugin(ctx: Context): void {
  ctx.inject([DOOM_UI_HUB_SERVICE], (uiContext) => {
    const handle = requireDoomUiHub(uiContext).registerLeader({
      source: '@example/review-extension',
      bindings: [
        {
          id: 'review.open',
          path: [{ key: 'r', label: 'review' }],
          command: { name: 'review' },
        },
      ],
    });
    return () => handle.dispose();
  });
}
```

Mount this plugin beneath the shared Doom Cordis host. The injection fiber stays pending until the
UI provider appears, owns the registration while it is active, retracts it when the provider
disappears, and rebinds it to a replacement provider.

## Session boundaries

The contracts coordinate runtimes; they do not create global persistence. Team owns
`doom/background-work`, `doom/delegation`, `doom/subagent-policy`, and `doom/fable-plan` for the
active session. Parent and child processes install their own providers and consumers. Fiber lifetime
and generation tokens prevent stale providers from controlling a later session.

Use these contracts when authoring DoomPi extensions, host adapters, Help contributors, Leader
entries, mode owners, Team consumers, transition integrations, or Voice-aware capabilities.

The readiness coordinator lets factories register capabilities immediately while package-specific
startup continues in the background. Calls can await only the package they use, and session
disposal aborts pending generations before hot reload installs replacements.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
