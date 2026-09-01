# @agimon-ai/doompi-web

Web cockpit for DoomPi. It discovers running [doompi-server](https://www.npmjs.com/package/@agimon-ai/doompi-server) sessions, multiplexes their authenticated sockets, and serves them through one browser connection.

This package is a composable [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) subsystem.
It registers no Pi extension and adds nothing to an interactive session.

## How it runs

`doompi-web` is a standalone process, not a Pi extension. Do not add it to `.doom/modes.yaml`. Run it directly, or start it through `doompi-server --web`.

## Requirements

- Node.js 22.19.0 or newer
- `doompi-server` sessions to attach to. The cockpit can start them itself.

## Install

```bash
npm install -g @agimon-ai/doompi-web
```

## Run

```bash
doompi-web
```

Open `http://127.0.0.1:7433`. With no flags, the hub watches `~/.doompi/run`, attaches to registered sessions, and resolves the union of their synchronized cockpit compositions from `~/.pi/.doom/sync/registrations`. The directory that launches `doompi-web` does not select the bundle. Sessions started by the cockpit use the server and agent from the same installation.

If `~/.pi/.doom` does not exist, the command runs its bundled `doompi init` before starting. If a hub already answers on the port, a second `doompi-web` process prints its URL and exits.

To run this repository's build with its composition pinned and watched:

```bash
pnpm cockpit:build
pnpm doompi-web --dir=<PWD>
```

`--dir` accepts `--dir <path>` too. It synchronizes that repository before launch and watches it for development rebuilds.

| Flag              | Default                  | Meaning                                          |
| ----------------- | ------------------------ | ------------------------------------------------ |
| `--dir`           | live-session union       | Pin, sync, and watch one repository composition  |
| `--registry-dir`  | `~/.doompi/run`          | Registry to watch (also `DOOMPI_RUNTIME_DIR`)    |
| `--spawn-command` | this install             | Command launching sessions created from the page |
| `--port`          | `7433`                   | HTTP port                                        |
| `--host`          | `127.0.0.1`              | Bind address                                     |
| `--assets`        | synchronized or packaged | Override the built SPA directory                 |
| `--state-dir`     | `~/.doompi/web`          | Remote-access settings and cockpit cache         |
| `--cloudflared`   | from `PATH`              | Tunnel binary (also `DOOMPI_CLOUDFLARED`)        |
| `-h`, `--help`    |                          | Print command help                               |
| `-v`, `--version` |                          | Print the installed package version              |

Install [doompi-server](https://www.npmjs.com/package/@agimon-ai/doompi-server) when you also want to run a session server directly. The hub does not require `doompi-server` on `PATH` to create sessions.

## Security

Attach tokens are read by this process from the token files the registry names and never reach the
browser. The server binds loopback by default, so reaching the cockpit already means having an
account on the machine. Remote access means tunnelling the port, for example over SSH; do not bind
a public address and call it done.

Loopback binding is not on its own an authorization boundary, because two request shapes escape it
and both reach code execution:

- **WebSockets are exempt from CORS.** Any page in any browser on this machine can open a socket to
  the cockpit's port, and `session_command` frames carry prompts straight to an agent holding a
  `bash` tool.
- **A cross-origin POST need not be preflighted.** Sent as `text/plain`, it still parses as JSON
  server-side, so a page could spawn a session in any directory without ever reading a response.

Both are refused. Every request and every socket upgrade is checked against an origin and host
allowlist derived from the port actually bound, plus the vite dev server. A request carrying no
`Origin` is allowed, because curl, the health probe, and the test harness send none and a browser
always sends one where it matters; this defends against a hostile web page, not against a hostile
local program, which can send whatever headers it likes. `DOOMPI_WEB_ALLOW_ORIGIN` takes a
comma-separated list for setups this package cannot guess. The host check is also the DNS rebinding
defence, and it is the only check a socket upgrade gets, since the upgrade path never reaches the
server's own host parsing.

## What the cockpit shows

Everything comes from Pi's RPC protocol, so a bare Pi session and a DoomPi session both work and
neither is shown facts it did not report:

- **Sessions rail:** every registered session with its live status line, git branch, and working
  directory. Cards switch focus (digits `1`-`9` too), `ctrl+t` or the button creates a session in a
  directory you pick, and the hub launches a `doompi-server` there.
- **Timeline:** user prompts, streamed assistant text and reasoning, and tool calls from running to
  result, including failures. Scoped to the focused session; the others keep streaming into the
  hub's ring for when you switch.
- **Composer:** prompts while idle, steering while a run is in flight, queued follow-ups, and abort.
- **Status rail:** connection state with replay and drop counts, model, thinking level, context
  usage, cost, and session identity.
- **Dialogs:** the extension UI sub-protocol (`select`, `confirm`, `input`, `editor`), which is how
  a permission prompt reaches the browser. Cancelling answers the agent rather than stranding it.
- **Notifications:** live `doom-notification` entries from every attached session, including sessions
  that are not focused. Browser permission is requested only after the user clicks **allow notifications**
  in Settings. Replayed backlog and historical pages update the timeline but never notify.
- **Leader Space:** `ctrl+k`, `ctrl+space`, or space in an empty composer. Keys walk the tree the
  installed web plugins declared (`SPC w r` opens the workflows tab, `SPC g e` toggles goal mode),
  backspace climbs, and `/` searches whatever `get_commands` reported to run it as a slash prompt.
- **Settings:** the gear at the foot of the rail opens the settings pages. Notifications shows this
  browser's permission and provides the user-click permission action. Providers lists every model
  provider Pi knows with whether it is authenticated, signs in with an API key or OAuth through the
  hub, and signs out. The hub uses the same `auth.json` as the sessions, so a login here is a login for
  every session on the machine.

## Attach and reattach

The hub, not the page, holds each session: it is the one client `doompi-server` allows, and every
browser tab multiplexes behind it, so two tabs on one session work. Losing the browser changes
nothing for the agent; the hub keeps a bounded ring of each session's frames and replays it when a
page subscribes, reporting how many frames the ring had to drop. If another client holds a socket,
the rail says so and the hub keeps retrying with backoff until it can take over. A page cannot
perform the handshake itself: `attach` frames sent from the browser are refused.

## Current limits

- One agent per `doompi-server` process; the hub presents many such servers as one working set.
- The four DoomPi selection axes (profile, major mode, domains, minor modes) are not exposed over
  Pi RPC, so the rail does not display them. The palette can still invoke the commands that change
  them.
- Subagent, workflow, and runner surfaces report summaries only; per-run detail has no RPC source
  to render from yet.
- Open pages show full live browser notifications. An installed paired PWA can also receive a generic
  zero-TTL Web Push alert while closed. There is no durable subscription database, outbox, replay, or
  historical delivery.

## iPhone Home Screen app

Use a stable named HTTPS tunnel such as `doompi.agimon.win`. Quick-tunnel hostnames rotate, so they cannot
provide durable PWA identity, passkeys, or reliable Push subscriptions. Open `/pair` in Safari, add it to the
Home Screen, then launch the installed app and scan the QR shown by the host.

The install shell, scanner, manifest, and verifier worker are package-owned. The QR pins the host signing key
and minimum bundle revision. The worker verifies every host and plugin asset before committing it to the
active cache, and the host never serves its SPA directly. A failed update keeps the last-known-good bundle.
Signer loss, signer rotation, or a host/container transition requires explicit fingerprint confirmation and
re-pairing. Session file previews remain sealed `no-store` HTTP Blob URLs and never enter the application
cache, IndexedDB, a signed manifest, or a Push payload.

Closed-app alerts are opt-in under settings. The server keeps subscriptions only in memory and sends fixed
generic copy with `TTL: 0` only when the device has no connected cockpit socket. Opening the app after a host
restart re-registers the browser subscription. Disabling alerts, revoking or expiring the device, switching
off remote access, or rotating process credentials removes it.

## Remote access

Working from a phone means putting the cockpit on the internet, and the cockpit's socket carries
prompts to an agent holding a `bash` tool. Reaching it is therefore equivalent to a shell on this
machine, and the whole design follows from that.

Switching it on binds a **second loopback listener** on an ephemeral port and points `cloudflared`
at it. Port 7433 is untouched, so working at the keyboard is exactly as before, while everything
arriving on the tunnel listener has to prove it holds a paired session. The two listeners are the
mechanism, not an implementation detail: a tunnel connects from `127.0.0.1` like every local client,
so the socket a connection arrived on is the only thing about it that cannot be forged.

Pairing takes **two** things, not one:

1. The host shows a QR encoding `https://<tunnel-host>/pair#c=<code>&k=<channel-key>&s=<signer>&r=<revision>`.
   Every value rides in the URL fragment, which no browser sends to a server, so the relay cannot replace the
   channel or bundle key without changing what was shown on the host. Manual pairing requires comparing the
   signing-key fingerprint shown on both devices.
2. Scanning raises an approve or deny prompt **on the host**. Nothing is paired until someone at the machine
   answers. A screen is visible over a shoulder and in a screenshare, so the code alone is one factor for a
   credential that ends in shell access.

A paired device then has the same powers as the person at the keyboard, with one exception: it
cannot mint pairing codes, approve devices, or change these settings. A device able to approve
devices could make its own access permanent, which is precisely what host confirmation prevents.
Turning remote access off and revoking a device are allowed remotely, because a panic button is
worth more from the couch than from the desk.

Two optional time limits, both **off by default** and both in the dialog:

- Close the tunnel automatically, after 60 minutes.
- Expire paired sessions, after 30 minutes idle or 12 hours total.

Either switch takes effect retroactively in both directions, because expiry is evaluated against the
setting in force at the moment of the check rather than stamped onto a session when it was made.
Turning expiry on therefore drops sessions that are already idle, and turning it off brings them
back.

With both off, a paired device keeps its session until it is revoked, remote access is switched off, or
the hub restarts. Switching remote access off always revokes every paired session, and that is not a
toggle.

Before reporting success, the tunnel is **self-tested through its own public URL**: the pairing page
must answer 200 and `/api/health` must answer 401. Anything else means the agent is on the public
internet unguarded, so the tunnel is killed immediately rather than warned about.

Requires `cloudflared` on `PATH` (`brew install cloudflared`). A quick tunnel needs no account but gets a new
hostname on every start. It does not provide a durable PWA, passkey, or Push identity, and Cloudflare does not
support SSE on quick tunnels, which breaks workflow and runner-log plugin surfaces. Use a stable named tunnel
for the Home Screen app.

If a named tunnel's connector exits unexpectedly, the hub makes three backoff restart attempts and
self-tests every replacement. The existing listener and paired sessions stay valid while recovery is
in progress. A quick tunnel cannot recover transparently because its origin changes, so it still fails
closed immediately. Exhausting named-tunnel recovery also switches remote access off and revokes the
paired sessions.

### Passkeys and step-up

On a named tunnel, a device can enrol a passkey once and then sign in with a gesture instead of
another QR. Two actions need a fresh gesture even from a live session: writing or clearing a model
provider's credential, and spawning a session in a directory of the caller's choosing. Both are
escalation paths out of "drive the agent" and into "own the machine". Ordinary prompting and tool
approval are deliberately ungated, because a biometric check in that loop gets trained away in a day.

A quick tunnel cannot carry a passkey: `rpID` is bound to the hostname and a quick tunnel's rotates
on every start, so a credential enrolled today would silently stop working tomorrow. The cockpit says
so rather than letting the ceremony fail in the browser.

### Tunnel-provider trust and payload privacy

Cloudflare terminates TLS and delivers the package-owned pairing and verifier bootstrap. A browser cannot
independently authenticate that first executable shell against the same edge that served it: a malicious
replacement could omit the worker and steal a QR fragment. DoomPi does not claim protection from a malicious
code-delivery edge.

After that bootstrap, **bundle signing is mandatory**. The QR pins the host ECDSA key and revision floor. The
worker verifies the signed manifest plus every raw asset before any host JavaScript executes, serves only the
atomically committed verified cache, and retains the last-known-good revision on failure. Cloudflare may
alter the raw bytes, but altered bytes do not execute.

**The payload is also sealed.** A QR carries an ephemeral P-256 public key in the fragment. A returning
passkey device restores its channel only after the pinned bundle worker accepts the same signer. Both paths
complete ECDH and derive separate AES-256-GCM keys per direction. Socket frames and API bodies travel as
ciphertext.

The channel implementation lives in `@agimon-ai/doompi-web-security`, which ships the envelope contract,
a `node:crypto` half, and a WebCrypto half. **A web plugin that calls `fetch` directly sends plaintext to
the relay**, so plugins use `sealedTransport.fetch` from that package's `./browser` subpath. The host
cannot enforce this, which is why the import allowlist admits the helper and why it is said here.

Cloudflare can still observe the served page and assets, timing, message sizes, connection patterns, and
tunnel metadata. Do not enable this transport if Cloudflare is outside your trust boundary. Protect a
named-tunnel account with a passkey or hardware MFA.

### What a paired device may browse

While a tunnel is up, the new-session picker answers a request arriving on it from one subtree only:
the directory `doompi-web` was started in. Unpinned, that route hands a paired device a map of the
machine, every project and client name and checkout, which is worth more to an attacker than most of
what the cockpit shows.

Only that request is pinned. The person at the keyboard already has a shell, so pinning them would
cost the picker its usefulness and buy nothing, and a contained cockpit needs none of it because its
mounts are already the boundary.

Session creation itself is not narrowed by this. `POST /api/sessions` still accepts any absolute path
a caller already knows, which is why the container below exists: it is the boundary, this is only the
end of casual enumeration.

### Running the cockpit in a container

Off by default. A second switch in the same dialog moves the whole cockpit into a container when
remote access is turned on: the hub, every session server it spawns, every agent, and `cloudflared`
itself. This is the answer to the blunt fact that a paired device drives an agent holding a shell,
which every layer above narrows access to but none of them contains.

The list of workspaces is the boundary, and it is the only thing on the host the container can see.
A hub inside the container cannot create a session in a path that is not mounted, so spawning in an
arbitrary directory is closed by construction rather than by a check. Not mounted, and deliberately
so: your home directory, `~/.ssh`, `~/.gitconfig`, the container socket, and every repository you
did not list.

What happens when you turn it on:

1. The image is built if this DoomPi version has not built it before, which takes minutes the first
   time. Progress is printed in the terminal that started the cockpit.
2. The host cockpit answers the request, then stops serving and releases its port.
3. The container starts, publishing the same port on loopback, and becomes the cockpit. Your browser
   reconnects on its own; there is no new address to remember.
4. Sessions working inside a mounted workspace are stopped on the host and recreated inside. Sessions
   working anywhere else are named in the terminal and stay on the host, where the contained cockpit
   cannot see them.

If the container fails to start, the host cockpit comes back and its sessions are recreated there, so
a failed move never leaves you with nothing listening. `Ctrl-C` stops the container. A cockpit killed
outright leaves the container running; the next start finds it through `~/.doompi/web/cockpit-container.json`
and stops it.

Two things carry across the boundary and nothing else does. Provider credentials go through the
existing broker, which hands the container a per-session token rather than your keys. Git identity is
passed as `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, so an agent can commit but cannot push, because no
key crosses.

What this does not defend against, stated plainly: anyone who can talk to the container daemon can
escape any container it runs, so the engine is part of the trusted base. Sessions share one container
and can read each other's mounted workspaces. A mounted workspace is fully writable, so the agent can
still destroy the repository you gave it. Network access is unrestricted, exactly as it already is for
`doompi --sandbox`. And plugin tabs fall back to the built-in set until a bundle is synced inside.

Requires `@agimon-ai/doompi-sandbox` in the composition and a container engine on the host.

## Planned: WebRTC transport

Today the page reaches the hub over two WebSockets, and any remote access means putting a tunnel in
front of them, which puts the tunnel provider in the path of everything. A WebRTC data channel would
replace that, with the tunnel demoted to carrying signaling only. Two independent reasons want it,
and the first is the stronger.

**Realtime voice.** `@agimon-ai/doompi-voice` now captures on the selected browser client, sends
mono PCM16 through its authenticated session media transport, keeps VAD and Whisper on the agent
host, and plays narration with browser speech synthesis. Voice activation is when the page asks for
microphone permission, never on load. A future WebRTC implementation can replace the HTTP media
adapter with Opus tracks while preserving the same client device and transport contracts.

**Confidentiality.** A QR shown on the host can carry the DTLS fingerprint, which authenticates the
peer connection out-of-band. The data path is then peer-to-peer DTLS: the tunnel provider usually
never carries the traffic and can never read it. That is close to VPN-grade confidentiality without
asking anyone to install a VPN.

The cost is real and worth stating: a WebRTC stack on the Node side (`node-datachannel` or
`werift`), a second client transport alongside `wsClient.ts` and `piTransport.ts`, ICE and NAT
traversal debugging, and a TURN relay fallback for the connections that cannot go direct. TURN
reintroduces a relay, though still one that cannot decrypt. The WebSocket transport stays as the
fallback for when a data channel cannot be established.

No date. This is a design note, not a commitment.

## Public API

```ts
import { serveWeb } from '@agimon-ai/doompi-web';
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm lint
pnpm exec vibe-lint check .
npm pack --dry-run
```

### Plugin dev loop

Two servers, so two terminals, and neither takes a flag. `pnpm dev` serves the cockpit from source
on port 7434 and proxies `/api` (including the socket) to the hub on 7433. Point it at plugin
packages and their `web/` sources hot-reload too, generated into `.dev/` and aliased over the empty
committed registry exactly as `doompi sync` does:

```bash
pnpm cockpit                                   # terminal one, at the repository root: the hub on 7433
pnpm dev                                       # terminal two, here: the composition the last doompi sync bundled
DOOMPI_WEB_PLUGIN_ROOTS=/path/to/pkg pnpm dev  # or an explicit list, path-delimiter separated
```

The roots come from `pluginRoots.json`, which `doompi sync` writes beside its bundle under
`~/.doompi/web/current`, unless the environment names them. The hub side is unchanged: a plugin's
hub channel is still the built `dist/webHub.mjs` the synced registry names, so a hub-side change
needs `pnpm build` in that package and a hub restart.

`pnpm test:e2e` drives the built executable in a real browser against a scripted session socket, so
run `pnpm build` first.

Maintained by [Agimon](https://agimon.ai/about).

## Web plugins

Tabs beyond the conversation are plugins, and no plugin package is a dependency of this one. A
package declares a `doompiWeb` block in its package.json naming a client entry (a `webPlugin`
definition: tab, panel, badge, session data channels, tool renderers for the timeline cards of
the tools the package registers, slots it opens for other plugins, fills into slots others open,
and the host's own slot contributions) and an optional hub entry (`webHubChannels` plus its built
dist). This package's own bundle carries no plugins; the full set is assembled on your machine.
`doompi sync` discovers the installed composition's manifests, generates the import entries, and builds
the SPA through the `./bundler` subpath inside the repository/worktree's immutable sync generation.
The shared server uses the validated registration for its startup repository. `--assets` and
`DOOMPI_WEB_DIST` override registered assets, then packaged assets provide the fallback. Server-only
`webPlugins.server.json` sits beside the public `web/` directory, never inside the signed or served
bundle. It names each plugin's built hub entry, imported lazily. A missing plugin package logs a notice
and its tab is omitted. Session package API routes use the session `cwd` registration, while
`DOOMPI_API_DIR` remains the explicit API override. `@agimon-ai/doompi-team` is the reference plugin;
the workflows tab ships with `@agimon-ai/doompi-workflow`. Contracts come from
`@agimon-ai/doompi-web-contracts`.

A tool call's timeline item belongs to the plugin that registers the tool: its `toolRenderers`
entry names the tool (or claims it with `matches` when the name is only known at runtime) and
supplies one `message` component that owns the whole item, composed from the components package's
`MessageItem` so it looks like every other item; the host only marks the row, catches a renderer
that throws (the item falls back to the host's own and the rest of the timeline survives), and
stands in for a tool nobody claims. Tool messages receive the same actions as every other plugin
component (`sendSessionFrame`, `openTab`, `renderSlot`), so a card can act, MCP-app style.

Plugins are independent. A manifest names no other plugin and `registrationOrder` is only an
optional tiebreak (default 1000, then plugin id): every relation between two plugins resolves by
name once all of them are installed. A plugin opens slots named `<pluginId>.<name>` and renders
them with the `renderSlot` and `slotData` props its components receive; any plugin fills them, and
the host's `overlay`, `rail`, `selection-bar`, `composer-actions`, `activity`, and
`activity.<group>` slots, without
knowing whether the owner is installed. A fill into a slot nobody declares, or two plugins wanting
one tab id, tool name, group name, or Leader Space leaf, never fails the page: the install resolves
it (the first plugin keeps a shared name, a later binding takes a leaf over as the TUI documents)
and records an install diagnostic, which `webPluginDiagnostics()` lists and the page logs once with
`console.warn`. `doompi sync` treats a malformed or half-installed plugin package the same way, as a
notice that skips that package. The repository's own composition is held to zero notices and zero
diagnostics by `tests/contract/workspaceWebPlugins.test.ts`.

## License

Source available under the DoomPi Web License (see LICENSE). Use is free for any purpose, including
production and commercial use, and you may modify it and publish patches. Redistributing the
software, or offering it to third parties as a hosted or managed service, is not permitted.
