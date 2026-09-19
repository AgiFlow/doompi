# Security model

[Back to DoomPi](../README.md)

A DoomPi agent may have shell access. The security architecture therefore separates four questions:

```text
Who can reach the listener?  -> listener, Host, and Origin policy
Which device may act?        -> host-approved pairing and device session
What can the relay read?     -> signed assets and sealed application traffic
What can the agent reach?    -> host process today; container plan is not wired
```

Authentication decides who may ask the agent to act. Sealing limits what a tunnel provider can read
or change after bootstrap. A container can limit which host resources the agent reaches, but the
current remote runtime does not wire the cockpit handover. A paired and encrypted session is still
dangerous when it controls an uncontained shell.

This guide starts with the threat model, then follows a remote request from listener classification through device proof, transport protection, and containment. [Trust and data boundaries](trust-and-data-boundaries.md) inventories executable inputs, credentials, model calls, voice, native binaries, and telemetry.

## Threat model

What each layer is meant to do:

| Threat                                                                    | Answer                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A web page you visit driving your cockpit through your browser            | Origin and Host checks, upgrades refused                           |
| Anyone on the internet reaching a tunnel and using the cockpit            | Pairing, host approval, per-device sessions                        |
| A device keeping access longer than intended                              | Revocation, remote shutdown, and opt-in idle and absolute expiry   |
| The tunnel provider reading or altering traffic after a trusted bootstrap | Signed bundles and sealed payloads                                 |
| A paired device browsing paths outside the intended workspaces            | No tunnel-only directory limit; use separately managed containment |
| An agent reaching host files                                              | No active cockpit boundary in the current remote runtime           |

What it is not built to stop, stated once here and again at the end: a compromised container engine,
a hostile process already running as you, a bad model given a good prompt, or the agent destroying
the repository it was handed.

## Loopback is not an authorization boundary

Binding the cockpit to `127.0.0.1` keeps it off the public network, but does not authorize callers:

- Local processes can reach a loopback port.
- WebSocket handshakes do not use the normal CORS preflight. Without an Origin check, a hostile
  page could open a socket and drive a session.
- A cross-origin `POST` with `Content-Type: text/plain` can avoid preflight. The browser may hide
  the response from the page, but the request can still cause a side effect.

DoomPi checks Origin and Host on both listeners, including WebSocket upgrades and mutation routes.
These checks address browser-driven requests; they do not authenticate a hostile local process.

## The listener is the boundary

One Hono app runs behind two sockets.

- The loopback listener is reachable by local processes.
- The tunnel listener faces the public internet. Cockpit requests need a paired
  device session, apart from the bootstrap routes below. Exact session MCP and
  OAuth routes are a separate exception: they authenticate at the application
  layer rather than through the paired-device cookie.

The guard is the first middleware on the app. Hono composes matching handlers in registration order,
so a guard added after a terminating handler never runs for that path.

### The unauthenticated allowlist

The pairing status endpoint takes its id in the query string precisely so the allowlist never needs a path parameter. A contract test pins the list so an addition cannot arrive without review.

| Route group                                             | Why it cannot require a session                               |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /`, `GET /pair`                                    | Entry and package-owned pairing shell                         |
| `GET /manifest.webmanifest`, `GET /sw.js`               | Install metadata and package-owned verifier worker            |
| `GET /pwa/pwa.js`, `GET /pwa/icon-{192,512}.png`        | Exact package-owned scanner and icon assets                   |
| `POST /api/remote/pair`, `GET /api/remote/pair/status`  | Claim and collect a host-approved pairing                     |
| `POST /api/remote/passkeys/authenticate/{begin,finish}` | Passkey proof creates a session                               |
| `POST /api/remote/passkeys/register/{begin,finish}`     | Direct pairing-page enrolment, still requires a device cookie |

The passkey authentication routes are public because proving a registered private key is how a returning device obtains a session. Registration is reachable from the shell but its handler still requires the paired device cookie. The PWA routes are package-owned bootstrap bytes, never host or plugin bundle bytes.

The path compared is the value the router matched on, which Hono has already percent-decoded. A
separately parsed pathname would let the guard and the router disagree about the same request, and
that disagreement is how an allowlist becomes a bypass.

### Origin and Host

Host is read from the `Host` header, never from a parsed request URL, because the WebSocket path
hardcodes `http://localhost` and a check against that value would pass for anything.

The loopback listener is lenient about a missing `Origin` and strict about one that is present. The
asymmetry is deliberate: a browser always sends `Origin` on a socket handshake and on a cross-origin
mutation, which is the attack being closed, while curl, the health probe, and the test harness send
none and would break for no security gain.

The tunnel listener requires `Origin` on anything with a side effect, including every socket
upgrade, and tolerates its absence only on a plain read, because following a scanned link is a
top-level navigation and legitimately sends none. Before the tunnel reports its own hostname there
is no origin to compare against, so that listener answers nothing at all.

`DOOMPI_WEB_ALLOW_ORIGIN` adds origins for a dev setup this package cannot guess. It is an operator
escape hatch, not part of the boundary.

## Proving a device

### Pairing

The host mints a 256-bit code and shows it as a QR. It is good for two minutes, is consumed by the
first claim, and is retired the moment a new one is minted.

Scanning does not pair anything. It raises a request the host must approve on the host's own screen within three minutes. An approved request stays collectable for twice that window, so an approval in the last second still reaches the phone's next poll. It can be collected once.

The status poll carries its request ID in the query string. That ID can redeem an approved request, so it is a short-lived credential and may appear in proxy or edge logs. Keep those logs inside the same trust boundary.

Guessing the QR token is not the practical threat at 256 bits. The separately displayed manual code
is eight digits, so failed claims are rate-limited per reported source. The first ten failures in a
one-minute window get the normal rejection; later attempts get a rate-limit rejection. The
implementation does not apply a separate lifetime failure count that automatically closes the
tunnel.

The address Cloudflare's edge reports is displayed and used to group public abuse throttling. It
does not authenticate or approve a device. Any local process can reach the tunnel listener directly
and set that header to anything.

### Sessions

Redeeming an approved request mints a 256-bit token. Only its SHA-256 is retained. The browser receives the token in `__Host-doompi_device`, an `HttpOnly`, `Secure`, `SameSite=Lax` cookie with `Path=/` and no `Domain`. The prefix makes the browser enforce the Secure, Path, and Domain constraints. `Secure` is constant rather than derived because `cloudflared` forwards plaintext and `x-forwarded-proto` is attacker-controlled.

The cookie is a bearer credential. `HttpOnly` prevents browser JavaScript from reading it, but same-origin code can still send requests with it. Origin checks, signed code delivery, and device revocation therefore remain part of the boundary.

Session expiry is off by default. While it is off, the server accepts an in-memory paired session
until the device is revoked, remote access is disabled, or the process restarts; the browser cookie
still has a thirty-day ceiling, but a surviving cookie cannot restore forgotten server state. When
expiry is enabled, the configured idle and absolute limits both apply. Disabling remote access
revokes every device, closes remote sockets, and clears pending pairing state.

### Passkeys

Where the tunnel has a stable hostname, a device can register a discoverable credential and sign in
without another QR. The relying party id is derived from the configured hostname and nothing else,
never from a request header, because `rpID` is the entire scope of a credential.

Three hostnames are refused rather than accepted and regretted: a quick tunnel, whose hostname
rotates on every start, so a passkey registered now would silently stop working on the next one; an
IP address, which WebAuthn rejects in the browser rather than here, which is a much worse place to
find out; and anything without a dot. DoomPi checks a nonzero authenticator signature counter and
revokes the credential if the counter repeats or moves backward. Many authenticators report zero,
so this can flag some cloned credentials, not prove that every clone is detectable.

### Step-up

A fresh passkey gesture is required for actions that widen machine access even when the device cookie is valid:

- `provider.login` and `provider.logout`
- `session.create` on the matched workspace admission, create, resume, and revive routes
- `settings.write`
- `mcp.discover` and `mcp.authorize`
- `computer-use.activate`

The assertion travels in `x-doompi-assertion`; its challenge is valid for sixty seconds. Ordinary prompting and tool approval remain on the device-session boundary. Quick tunnels cannot supply a stable relying-party ID, so passkey enrollment and step-up are unavailable there.

The route matcher is the boundary, not the action name. In particular, the compatibility route
`POST /api/sessions` is still served for older verified bundles and is not matched as
`session.create`; a paired remote caller can reach it through the sealed gateway without step-up.

## Keeping the relay out of it

Cloudflare terminates TLS at its edge. Without further work it reads, and can rewrite, everything
the cockpit carries. Two layers narrow that, both in `@agimon-ai/doompi-web-security`.

### The bundle is signed and verified before execution

Every other guarantee here rests on the cockpit JavaScript being what this hub built. The package-owned `/pair` shell, scanner, manifest, and `/sw.js` verifier are built separately from plugin-generated cockpit code. The QR fragment pins both the host's ECDSA P-256 SPKI (`s`) and the minimum signed revision (`r`).

The server keeps the signing state at `~/.pi/.doom/server/signing.json` at mode `0600`. Manifest v2 signs a canonical list containing revision, path, SHA-256, byte length, and MIME type for the regular files in each published asset tree. Source maps are deliberately skipped. The shell publication includes `/index.html`; plugin compositions are signed as separate immutable publications.

The worker fetches `/bundle-manifest.json`, rejects signer or revision conflicts, fetches only
`/bundle-assets/<revision>/*`, and verifies every byte before writing a staging Cache Storage entry. Only after the complete bundle passes does it atomically commit the active revision in IndexedDB. Navigations and static requests then resolve only from that verified cache. A failed refresh retains the last-known-good bundle. Missing WebCrypto, IndexedDB, Cache Storage, a pinned signer, or a required asset is a stop, not a request to execute unverified host JavaScript.

Signer loss, signer rotation, and host or container transitions require an explicit fingerprint confirmation and trust reset. Revision numbers are monotonic and a reused revision with different manifest bytes is refused. Session file assets never enter this pipeline: they use sealed `no-store` HTTP and ephemeral Blob URLs, not Cache Storage, IndexedDB, signatures, or Push payloads.

### The payload is sealed

The QR carries an ephemeral P-256 public key alongside the pairing code, in the URL fragment, which no browser sends to a server. The device completes ECDH against it and both sides derive AES-256-GCM keys through HKDF-SHA256, separately per direction.

After channel establishment, session and protocol socket frames travel as ciphertext. Ordinary remote HTTP calls use the sealed HTTP gateway, which encrypts the request and response payloads. Pairing, passkey ceremonies, PWA bootstrap assets, and channel establishment are intentionally unsealed because they are needed before a sealed channel exists.

Nonces are twelve bytes: a four byte random prefix and an eight byte counter. At 2^32 messages the
channel refuses to seal any more rather than reusing a nonce, which for AES-GCM is the failure that
loses the key. A receiver rejects any counter it has already passed, so a replayed frame is refused
rather than decrypted. Sends go through a serial queue, because two async seals racing would take
counters in one order and reach the wire in another, and the second to arrive would be read as a
replay of the first.

The QR supplies the host key out of band, so an honest bootstrap verifier can reject a substituted
channel key. That protection starts only after the verifier is trusted. The first pairing page and
its package-owned JavaScript still arrive through the relay, so a relay that alters that first load
can defeat the automatic check. This is trust on first use, not independent authentication of the
bootstrap page.

**A plugin that calls `fetch` directly sends plaintext to the relay.** Plugins use
`sealedTransport.fetch` from that package's `./browser` subpath, which the plugin import allowlist
admits for exactly this reason. The host cannot enforce it, which is why it is written down here.

### Closed-app Web Push is not an active server feature

The web client and service worker contain Push registration and notification code, and the shared
constants reserve `/api/remote/push` routes. The current server does not register handlers for those
routes or create a VAPID sender. Do not rely on closed-app delivery until both halves are wired.

## Narrowing what is in reach

### Directory and workspace scope

The current headless directory completion route is not narrower on the tunnel listener. Given a
typed path, it can read candidate parent directories based on the server working directory and known
session directories. An authenticated remote caller can reach that route through the sealed gateway.

Workspace APIs make the normal UI path explicit, and admitting or creating a workspace is covered by
step-up. They are not a filesystem sandbox. The compatibility route `POST /api/sessions` accepts a
caller-supplied working directory and, as noted above, is not covered by the current step-up matcher.
If host filesystem scope matters, run the server under separately managed containment. The cockpit
container plan described below is present in source but is not connected to the current remote
runtime.

### The container plan and current wiring

The settings and sandbox package define an opt-in cockpit container, but the current server runtime
does not connect it. `createRemoteAccess` needs a `requestHandover` callback and a `contained` flag;
`createRemoteRuntime` supplies neither. Enabling remote access with cockpit containment selected
therefore returns `This cockpit cannot hand over to a container.` No containment boundary is active
in that path.

The plan is still worth reading before wiring it. It puts the hub, every session server it spawns,
every agent, and `cloudflared` in one container rather than one container per session. With the hub
inside, `POST /api/sessions` could only name a path that is bind-mounted.

The configured workspaces are mounted at their identical host paths, so absolute paths keep
resolving. Home is a named volume, `doompi-cockpit-home`, which is where the signing key and the
container-side config and session state live; the signing state has to survive a restart, because a
changed signing key would make every paired device refuse the cockpit. Deliberately absent: the host home directory, `~/.ssh`,
`~/.gitconfig`, the container socket, and every repository not listed.

`DOOMPI_SANDBOX_DEVCONTAINER=0` is forced. A workspace carrying a dev container configuration would
otherwise replace the whole plan with an author-controlled one that can mount anything, including the container socket. That mode is a convenience elsewhere in DoomPi and is documented as such; silently inheriting it here would make the containment claim false.

One port is published, `127.0.0.1:<port>:<port>`, with the hub binding `0.0.0.0` inside because the
engine forwards to the container's external interface rather than its loopback.

The default plan crosses more than two things: configured workspaces, an allowlisted environment,
Git identity when available, the published loopback port, and the persistent container home. It also
allows network access. The current cockpit handover does not wire the provider broker into its
container plan, so allowlisted `*_API_KEY`, `*_AUTH_TOKEN`, and `*_BASE_URL` values can cross directly.
Do not treat cockpit containment as a credential boundary.

Git identity is passed as `GIT_AUTHOR_*` and `GIT_COMMITTER_*`; the host `~/.ssh` and `~/.gitconfig`
are not mounted by the default plan. That removes common host Git credentials, but it does not prove
that pushing is impossible. A mounted workspace, an environment value, an operator run flag, or a
credential created inside the container can still make a push possible.

Those are properties of the plan and harness, not observed behavior of the current server launch.
There is no handover or rollback path wired into the server runtime today.

## Defaults

Remote access, tunnel auto-close, and session expiry are opt-in. The containment
setting also defaults to off, but the current runtime cannot complete its container
handover. Host approval is always required for a new pairing.

| Setting           | Default | Why                                                                                                      |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| Remote access     | off     | Nothing is reachable beyond loopback until it is enabled                                                 |
| Tunnel auto-close | off     | A tunnel remains open until closed or the hub restarts                                                   |
| Session expiry    | off     | In-memory sessions last until revocation, remote shutdown, or restart; the cookie ceiling is thirty days |
| Container         | off     | The plan requires an engine and workspace list, but current server wiring cannot hand over               |
| Host approval     | always  | Scanning a code creates a request; it never pairs a device by itself                                     |

## What an attacker still gets

- **The container engine is part of the trusted base.** Anyone who can talk to the daemon can escape
  any container it runs. This does not defend against a compromised engine or a user in the `docker`
  group.
- **`DOOMPI_SANDBOX_RUN_FLAGS` validates shape, not meaning.** It accepts any `--flag=value`, so
  `--volume=/:/host` passes. It is an operator escape hatch, not a boundary.
- **The available plan puts sessions in one container**, so they can read each other's mounted
  workspaces. This matters if the handover is wired by a future runtime or another caller.
- **A mounted workspace is fully writable.** The agent can still destroy the repository it was given.
  The default mount plan omits other host paths, but the engine, environment, network, and operator
  run flags remain separate escape routes from that assumption.
- **Network access is not restricted by DoomPi**, as it already is for `doompi --sandbox`. The
  container engine and host network configuration decide what destinations are reachable.
- **The relay still sees traffic shape.** Timing, message sizes, and connection patterns survive the
  sealed channel.
- **The first page load is trust-on-first-use.** The pairing page itself is delivered by Cloudflare.
  Bundle verification does not independently authenticate that initial verifier page.
- **A local process can do all of this anyway.** None of the above is aimed at code already running
  as you, and none of it should be read as if it were.

## Where the code is

Kept short on purpose: a security claim you cannot check is a slogan.

| Concern                       | File                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| Listener, origin, allowlist   | `packages/core/doompi-core/src/services/remoteGuardPolicy/index.ts`    |
| Guard and sealed HTTP gateway | `packages/core/doompi-core/src/server/remoteRuntime.ts`                |
| Pairing handshake             | `packages/core/doompi-core/src/services/pairingFlow/index.ts`          |
| Device sessions               | `packages/core/doompi-core/src/services/deviceAuth/index.ts`           |
| Passkeys and step-up          | `packages/core/doompi-core/src/services/webauthnPolicy/index.ts`       |
| Bundle signing                | `packages/core/doompi-web-security/src/services/bundleSigner/index.ts` |
| Worker verification           | `packages/clients/doompi-web/src/pwa/serviceWorker.ts`                 |
| Signed publication routes     | `packages/core/doompi-core/src/services/webCompositions/index.ts`      |
| Sealed channel                | `packages/core/doompi-web-security/src/types/sealedChannel.ts`         |
| Session file response         | `packages/core/doompi-core/src/server/headlessServer.ts`               |
| Browser Blob URL              | `packages/clients/doompi-web/src/web/lib/sessionAsset.ts`              |
| Container plan                | `layers/sandbox/doompi-sandbox/src/services/cockpitPlan/index.ts`      |
| Container launch              | `layers/sandbox/doompi-sandbox/src/services/cockpitHarness/index.ts`   |

The policy modules keep most decisions free of I/O and close to the adapters that enforce them.
Start with the policy, then check the runtime wiring before treating a claim as a boundary.
