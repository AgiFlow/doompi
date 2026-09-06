# Getting started

DoomPi Web is a standalone cockpit process. It is not loaded by Pi and must not be added to `.doom/modes.yaml`.

## Requirements

- Node.js 22.19.0 or newer
- A DoomPi installation with a synchronized global or repository configuration
- `cloudflared` only when remote access is enabled

The cockpit can start `doompi-server` itself. You do not need a `doompi-server` executable on `PATH` for sessions created from the page when the bundled server is available.

## Install

For a published install:

```bash
npm install -g @agimon-ai/doompi-web
```

For a workspace checkout, install dependencies at the repository root and build the package:

```bash
pnpm install
pnpm --filter @agimon-ai/doompi-web build
```

## Start a local cockpit

```bash
doompi-web
```

Open <http://127.0.0.1:7433>. Startup runs the bundled `doompi init` when the personal DoomPi directory is missing. A second process using the same package version reports the existing URL and exits. A different version replaces an idle loopback hub, but does not interrupt a hub with live sessions.

The hub watches the default session registry at `~/.doompi/run`. Set `DOOMPI_RUNTIME_DIR` or pass `--registry-dir <path>` to use another registry. Existing `doompi-server` records in that registry appear in the sessions rail. New sessions created in the cockpit are launched through the bundled server unless `--spawn-command` is set.

## Select a repository composition

A session's web plugin composition is selected from its working directory. The repository's synchronized registration is tried first. If it is missing, incomplete, invalid, or cannot be synchronized, the global synchronized registration is used. The selected repository and global artifacts are never combined.

Use `--dir` to pin and synchronize one repository for a development cockpit:

```bash
doompi-web --dir "$PWD"
```

The path must be inside a repository. This synchronization happens before launch and before a new or restarted session. `--dir` does not watch the repository. Run `doompi sync` after changing its configuration, then create or restart the relevant session. The global synchronization guard is the only bundle watcher.

The current working directory does not select the bundle when `--dir` is absent. Use the repository containing the session, or use `--dir`, when testing repository-specific web plugins.

## Useful options and environment variables

| Option or variable          | Default                         | Effect                                                              |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `--dir <path>`              | none                            | Pin one repository composition and synchronize it on demand         |
| `--registry-dir <path>`     | `~/.doompi/run`                 | Change the session registry                                         |
| `DOOMPI_RUNTIME_DIR`        | unset                           | Environment equivalent of the registry default override             |
| `--spawn-command <command>` | bundled server                  | Choose the command used for cockpit-created sessions                |
| `--port <number>`           | `7433`                          | Choose the HTTP port                                                |
| `--host <address>`          | `127.0.0.1`                     | Choose the bind address; non-loopback addresses are unauthenticated |
| `--assets <path>`           | synced or packaged              | Override the host shell asset directory                             |
| `DOOMPI_WEB_DIST`           | unset                           | Environment override for host shell assets                          |
| `DOOMPI_API_DIR`            | generated current API directory | Override generated package API routes                               |
| `--state-dir <path>`        | `~/.doompi/web`                 | Store remote-access state and cockpit cache                         |
| `--cloudflared <path>`      | `PATH`                          | Choose the tunnel binary                                            |
| `DOOMPI_WEB_ALLOW_ORIGIN`   | unset                           | Comma-separated additional local origins for development            |

`doompi-web --help` prints the command's current option text. The `DOOMPI_WEB_ALLOW_ORIGIN` setting changes the local origin allowlist only. It does not make a public listener safe.

## Start remote access

Remote access is configured from the cockpit settings page. Install `cloudflared` first, then choose a quick tunnel or a stable named tunnel. A quick tunnel is suitable for a temporary connection. Its hostname changes on every start and cannot provide a stable passkey or PWA identity. Use a named tunnel for a Home Screen PWA, passkeys, or reliable Web Push subscriptions.

Enabling remote access creates a second loopback listener on an ephemeral port for the tunnel. The local listener remains on its normal port. The hub self-tests the public URL before reporting success. Pair a device by opening `/pair`, scanning the host-generated QR, and approving the request on the host. See [remote security](security.md) for the threat model and limits.

## Run from the workspace

From the repository root, build the cockpit composition and run the package with that repository selected:

```bash
pnpm cockpit:build
pnpm doompi-web --dir="$PWD"
```

For plugin client development, run the hub and Vite dev server in separate terminals from the package directory:

```bash
# repository root
pnpm cockpit

# packages/clients/doompi-web
pnpm dev
```

The dev server uses port `7434` and proxies `/api` to the hub on `7433`. Set `DOOMPI_WEB_PLUGIN_ROOTS` to a path-delimited list of plugin package roots when testing a plugin that is not in the last synchronized composition. Client changes hot reload. Hub channel changes require rebuilding the plugin and restarting the hub.

## Verify a change

Run these commands from `packages/clients/doompi-web`:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint
```

Build before `pnpm test:e2e`; the end-to-end suite drives the built executable in a real browser.
