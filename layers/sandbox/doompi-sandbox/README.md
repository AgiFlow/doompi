# @agimon-ai/doompi-sandbox

Container sandbox for DoomPi launches: the agent, extensions, and tools run inside Docker or Podman while the terminal stays on the host

This package is a composable [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) subsystem. Use it with the distribution or install it independently in [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

## Requirements

- Node.js 22.19.0 or newer
- `@earendil-works/pi-coding-agent` 0.84.2
- One of `docker`, `podman`, `nerdctl`, or `finch` on the host for sandboxed launches

## Install

```bash
pi install npm:@agimon-ai/doompi-sandbox
```

The package declares its Pi extension entry, so Pi loads it after installation. DoomPi users can include the package through their normal profile and domain composition instead.

## Sandboxed launches

With this layer in the selected major mode, `doompi --sandbox` moves the whole session into a
disposable Linux container instead of running Pi on the host:

1. The harness resolves this package's `./sandbox-harness` export and delegates the launch.
2. The layer detects the first available engine in the order `docker`, `podman`, `nerdctl`,
   `finch` (override with `DOOMPI_SANDBOX_ENGINE`), and builds the `doompi-sandbox:v<version>`
   image on first use. The image installs the DoomPi distribution from the registry, so the
   container never runs the host's platform-specific packages.
3. It starts `docker run --rm` with the repository bind-mounted at its host path, an isolated
   home volume, and a volume shadowing the repository's `.pi` package store. Inside, the
   `doompi` launcher replays the same major mode, domains, profile, and Pi arguments.

The terminal stays attached, so the session looks like a host launch while bash, file edits,
extensions, MCP servers, and skills all execute inside the container. `DOOMPI_SANDBOX=1` marks
every sandboxed process; nesting is refused.

Only an allowlisted environment enters the container: terminal and locale variables, proxy
settings, and `DOOMPI_PRESET`. Everything else a shell accumulates stays on the host.

## Engine and runtime selection

Every supported engine takes docker's `run` syntax. On macOS any docker-compatible VM manager
(Docker Desktop, OrbStack, colima, podman machine) works without configuration.

`DOOMPI_SANDBOX_RUN_FLAGS` passes extra options straight to the engine, which is how you select a
different isolation runtime without the layer having to know about it:

```bash
DOOMPI_SANDBOX_RUN_FLAGS=--runtime=runsc doompi --sandbox
```

Options must be self-contained (`--flag` or `--flag=value`). A separated value such as
`--runtime runsc` is refused, because a bare word cannot be told apart from an image name and
would silently launch a different container.

A stronger runtime that boots a VM rather than sharing the host kernel, such as Kata or
Firecracker, is untested here. Their filesystem passthrough is unlikely to carry the broker's
bind-mounted unix socket, so expect to turn brokering off or move it to a port first.

## Provider credential broker

The container never receives a provider API key. For each brokered provider the host holds a key
for, the launch:

1. Starts a broker on the host and grants the container exactly one route to it.
2. Replaces the credential variable with a random per-session token.
3. Redirects the provider's base URL at a loopback bridge inside the container, which forwards
   raw bytes to the broker.

How the container reaches the broker depends on the engine:

| Host                          | Transport                                   | Why                                                                                |
| ----------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| Linux                         | Unix socket, bind-mounted, owner-only       | Container and host share a kernel, so no port is needed                            |
| macOS, Windows, any VM engine | Loopback TCP through `host.docker.internal` | A container in a virtual machine cannot connect to a mounted host socket (ENOTSUP) |

On the TCP path the broker binds `127.0.0.1` on an ephemeral port, so it is never exposed beyond
the host, and the launch passes `--add-host` so the gateway name resolves on every engine. Another
local process could reach that port, and the session token is what stops it being useful.

The broker validates the token, swaps in the real key, and streams the provider response back.
Credentials for providers it cannot carry are withheld from the container rather than passed
through. Turn the whole mechanism off with `DOOMPI_SANDBOX_BROKER=0`.

## In-session command

```text
/doom-sandbox
```

Reports whether the current session runs inside the sandbox container or directly on the host.

## Current limits

- The broker carries a curated provider list. OAuth subscription logins held in `~/.pi` are not
  brokered and need a login inside the sandbox, since the host home directory is not mounted.
- A host `*_BASE_URL` override is dropped rather than used as the broker's upstream.
- Compositions that declare local workspace packages cannot load their platform-specific
  dependencies inside the Linux container; use registry-installed layers for sandboxed work.
- `dpi --sandbox` runs the harness rather than the synchronized fast path. That path loads Pi
  in-process against synchronized settings, and a fresh container has none to load, so the
  session is composed from the repository the way a first run is.
- Container network access follows the engine's defaults and is not restricted yet.

## Public API

```ts
import { DefaultSandboxExtensionService, activateSandboxExtension } from '@agimon-ai/doompi-sandbox';
import { launchSandbox } from '@agimon-ai/doompi-sandbox/sandbox-harness';
```

The Pi host entry is also available at:

```text
@agimon-ai/doompi-sandbox/extensions/pi
```

The service layer is host-neutral. The Pi entrypoint owns only command registration and its runtime-scoped installation guard, and the sandbox harness entry owns container provisioning for the DoomPi launcher.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm exec vibe-lint check .
npm pack --dry-run
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
