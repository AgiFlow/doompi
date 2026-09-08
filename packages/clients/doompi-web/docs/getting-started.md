# Getting started

DoomPi Web is a long-lived cockpit hub. It is not loaded into Pi and must not be added to `.doom/modes.yaml`.

Before starting it, choose the topology you want:

| Topology                 | Use it when                                        |
| ------------------------ | -------------------------------------------------- |
| Standalone `doompi-web`  | Several sessions should share one durable cockpit  |
| `doompi-server --web`    | One session should start a cockpit with itself     |
| Hub plus Vite dev server | You are developing browser plugins with hot reload |
| Tunnel listener          | A paired phone or remote browser needs access      |

In every case, session agents remain in `doompi-server` processes. The hub discovers those processes through a local registry and keeps their attach tokens out of the browser.

## Requirements

- Node.js 22.19.0 or newer
- A DoomPi installation with a synchronized global or repository configuration
- `cloudflared` only for remote access

The cockpit can start its bundled `doompi-server`. The executable does not need to be on `PATH` unless `--spawn-command` selects it explicitly.

## Install and start

```bash
npm install -g @agimon-ai/doompi-web
doompi-web
```

Open <http://127.0.0.1:7433>. The loopback bind is deliberate: the local listener has browser-origin defenses but no device authentication. Do not replace it with `0.0.0.0` for remote use.

On first start, the command runs its bundled `doompi init` when the personal DoomPi directory is missing. It then synchronizes the global cockpit root, watches the session registry, and attaches to live server records.

`doompi-web --help` lists every option and `doompi-web --version` prints the installed version. Both answer without
starting the cockpit, so neither loads the server graph. Options accept either `--port 7433` or `--port=7433`.

A second process using the same package version reports the existing URL and exits. A different version may replace an idle loopback hub, but it does not interrupt a hub with live sessions.

## How sessions appear

The default registry is `~/.doompi/run`. Each `doompi-server` record names its process, working directory, socket, and token file. The hub reads the token and occupies the server's authenticated client slot, then multiplexes browser pages behind that connection.

Existing live records appear automatically. Creating a session in the cockpit starts the bundled server unless `--spawn-command` changes the launcher.

Use `--registry-dir <path>` or `DOOMPI_RUNTIME_DIR` when the servers use another registry. The directory and token paths are a trust boundary, so keep a custom registry owner-only.

## Choose the web composition

A session's working directory selects its repository configuration. The hub tries that repository's complete synchronized web generation first, then the complete global generation. It never combines repository client code with global hub channels or APIs.

Use `--dir` when the cockpit should be anchored to one repository during development:

```bash
doompi-web --dir "$PWD"
```

The path must be inside a repository. The hub synchronizes it before launch and before creating or restarting a session. `--dir` is not a file watcher. After changing repository configuration or built plugin code, run `doompi sync` and create or restart the affected session.

Without `--dir`, the directory used to start the command does not choose every session's plugin set. Each session still resolves from its own working directory. Only the global synchronization guard remains watched after startup.

See [Web bundling and serving](bundle.md) for why the package shell and per-session plugins are separate.

## Start remote access

Remote access is configured in the cockpit settings page rather than by rebinding the local listener.

1. Install `cloudflared`.
2. Choose a quick tunnel for temporary access or a stable named tunnel for durable identity.
3. Enable remote access in Settings.
4. Open `/pair` on the device, scan the QR, and approve the request on the host.

The hub creates a second loopback listener for the tunnel and leaves port 7433 local. It probes the public pairing page and confirms that the public health route rejects an unauthenticated request before reporting success.

A quick tunnel gets a new hostname when restarted. It cannot provide durable passkeys, passkey step-up, installed-PWA identity, or reliable Push identity. Use a named tunnel for those controls.

Remote access reaches an agent that may hold shell tools. Read [Remote security](security.md) before enabling it. Pairing authenticates a device; it does not contain the agent or make plugins untrusted-safe.

## Command and environment reference

| Option or variable          | Default           | Effect                                                     |
| --------------------------- | ----------------- | ---------------------------------------------------------- |
| `--dir <path>`              | none              | Anchor one repository and synchronize it on demand         |
| `--registry-dir <path>`     | `~/.doompi/run`   | Select the session registry                                |
| `DOOMPI_RUNTIME_DIR`        | unset             | Override the default registry directory                    |
| `--spawn-command <command>` | bundled server    | Select the command used for cockpit-created sessions       |
| `--port <number>`           | `7433`            | Select the local HTTP port                                 |
| `--host <address>`          | `127.0.0.1`       | Select the local bind; a non-loopback bind is not paired   |
| `--assets <path>`           | packaged shell    | Override host shell assets explicitly                      |
| `DOOMPI_WEB_DIST`           | unset             | Environment equivalent of the shell asset override         |
| `DOOMPI_API_DIR`            | generated default | Override the default hub package API directory             |
| `--state-dir <path>`        | `~/.doompi/web`   | Store signing material, remote settings, and cockpit state |
| `--cloudflared <path>`      | `PATH`            | Select the tunnel binary                                   |
| `DOOMPI_CLOUDFLARED`        | unset             | Environment equivalent of the tunnel binary override       |
| `DOOMPI_WEB_ALLOW_ORIGIN`   | unset             | Add comma-separated local development origins              |

`doompi-web --help` prints the current command syntax. `DOOMPI_WEB_ALLOW_ORIGIN` changes browser-origin policy for known development setups. It does not authenticate a public listener.

## Run from this workspace

From the repository root:

```bash
pnpm install
pnpm cockpit:build
pnpm doompi-web --dir="$PWD"
```

`cockpit:build` builds the hub, shell, session server, and packages used by the repository composition. The `--dir` launch synchronizes that repository before serving it.

## Develop a browser plugin

Use two terminals:

```bash
# repository root: build and run the real hub on 7433
pnpm cockpit

# packages/clients/doompi-web: run Vite on 7434
pnpm dev
```

The Vite server proxies `/api`, including the browser socket, to the hub. Set `DOOMPI_WEB_PLUGIN_ROOTS` to a path-delimited list of package roots when the plugin is not in the last synchronized composition.

Client entries hot reload because Vite compiles their source. Hub channel entries and package APIs are built Node.js modules. Rebuild the owning package and restart the hub or session after changing them.

The production bundler deduplicates shared browser runtimes and signs immutable plugin publications. The dev server optimizes iteration and should not be used as evidence for the production remote-security boundary.

## Verify a package change

Run from `packages/clients/doompi-web`:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint
```

Build before `pnpm test:e2e`; the browser suite drives the built executable. See [Web plugins](plugins.md) for contribution contracts and [Architecture](architecture.md) for process ownership.
