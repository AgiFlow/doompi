# @agimon-ai/doompi-help

Activation-gated package guidance and read-only diagnostics for DoomPi agent setup and debugging.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

> **Alpha:** Help contribution contracts may change between releases.

## Requirements and installation

Requires Node.js 22.19.0 or newer and the Pi version declared in this package's peer dependencies. The distribution selects Help through `default.packages` in `modes.yaml`; it remains configurable rather than fixed host infrastructure.

For standalone Pi:

```bash
pi install npm:@agimon-ai/doompi-help
```

Pi loads `/extensions/pi`; the web/server host loads `/extensions/server`. Both use the same Help activation contract through their native adapters.

## Activate and diagnose

Use the minor-mode menu, `SPC h e`, `/minor help`, or `/doom-help`. `/doom-help` toggles on both hosts. Help is additive: unrelated tools, skills, and modes retain their existing activation and permission rules.

The mode detail reports applied Help skill and diagnostic-tool counts. Pending discovery is not presented as a successful skill count. A failed contributor can leave Help degraded while healthy contributions remain usable.

| Capability       | Owner        | Purpose                                                                            |
| ---------------- | ------------ | ---------------------------------------------------------------------------------- |
| `help_status`    | Help         | Applied Help skills/tools, owners, availability, and bounded diagnostic codes.     |
| `diagnose_setup` | Distribution | Saved configuration, installed packages, and sync drift for the current workspace. |
| `diagnose_agent` | Log          | Bounded current-session captured failure and token-usage evidence.                 |

Optional owners contribute only when present in the composition. The entry skill `doompi-use-help` routes to configuration, profile, mode, domain, skill, and debugging guidance rather than loading every document eagerly.

Diagnostics do not install packages, change configuration, authenticate servers, clear logs, or restart processes. Existing approval and permission boundaries apply to repairs. Agent telemetry distinguishes empty or unavailable data from captured evidence and never treats absent records as proof of health.

Deactivation removes Help-only capabilities from future prompts, catalogs, and calls. Stale tool references are rejected. Supported in-flight work is cancelled, but completed effects cannot be undone. Earlier tool results and guidance can remain in conversation history; cached files may remain on disk.

## Package-owned contributions

Use named routes under `src/extensions/workspaces/sessions/(backend)/resource/` and `tool/`. Root files own shared state and lifecycle. Do not create a second tool registry inside Help or add executable callbacks to the documentation descriptor.

### Skills

For Pi, contribute `{ source, moduleUrl, skills: [{ name, description }] }` through a resource route or an owning `DOOM_HELP_SERVICE` injection. The source identifies the exact package; the package's H1-led `llms.txt` links to published `src/prompts/<name>/SKILL.md` files. Pi resolves installed content first, then its exact-version cache, then the integrity-verified exact-version fallback.

For the server, declare a normal skill resource with `HELP_WHEN`, a useful description, and `path: packageResourcePath(import.meta.url, 'src/prompts/<name>/SKILL.md')`. Its reader returns the same file. Validate required content and report unavailable resources rather than registering empty successful guidance. Keep package documents lazy; eager context is only for small live activation instructions.

Publish `llms.txt` and `src/prompts` in the package files allowlist. Relative links must remain inside the published package. Normal runtime skills retain their ordinary activation rules; content-only domain plugin schemas are not changed by this feature.

### Tools

```ts
import { DOOM_HELP_WHEN as HELP_WHEN, createPiHelpToolGate } from '@agimon-ai/doompi-core/help';
```

Contributor packages import the shared contract from Core, not the optional Help package, so the distribution does not acquire an unconditional minor-mode dependency.

A server tool uses `when: HELP_WHEN`, remains owned by its normal facet, and checks the active host and Help selection at execution boundaries. Domain conditions can be combined with Help when both are required. Help does not bypass other restrictions.

Pi's portable `when` metadata alone does not gate native tool registration. In the owning Pi root, create `createPiHelpToolGate(packageName, toolNames)`, install its `services`, and call its `onStart` after named tool registration. Each contributed tool calls `gate.assertActive(toolName, execution.signal)` before work and checks the returned signal and current authorization before returning results. This reuses the ordinary tool-surface restriction service and fails closed while Help or its session provider is absent.

The Log package's `diagnose_agent` routes are the first-party example of both adapters. Provider replacement, late arrival, withdrawal, cancellation, and package shutdown must preserve owner cleanup. Adding Help never grants filesystem, shell, network, or remote MCP access.

## Public API

The root export retains the activation, storage, resolver, and runtime services. `/extensions/pi`, `/extensions/server`, and `/extensions/web` retain their existing roles. Contributor packages use the shared Help condition and Pi tool gate from `@agimon-ai/doompi-core/help`. Re-exports live under `src/exports`.

The Help service binds the skill consumer's accepted inventory instead of assuming every resolved descriptor reaches the model. Server status reads the host's applied capability metadata. Neither status API exposes executable declarations, credentials, raw logs, or skill bodies.

## Verification

```bash
pnpm nx run @agimon-ai/doompi-help:test
pnpm nx run @agimon-ai/doompi-help:typecheck
pnpm nx run @agimon-ai/doompi-help:lint
```

Tests cover contribution withdrawal and rollback, Pi provider replacement and restrictions, the real headless prompt and tool surface, explicit skill reading, deactivation, and remote MCP exclusion. Packed-install checks must also verify resource paths outside the checkout before release.

## License

MIT
