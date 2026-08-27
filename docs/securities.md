# Security model

[Back to DoomPi](../README.md)

This document explains DoomPi's threat model, remote-access controls, containment boundary, and known limits. [Trust and data boundaries](trust-and-data-boundaries.md) inventories what happens to credentials, commands, model traffic, and telemetry.

## The premise

A DoomPi agent has a shell. Security controls therefore answer two separate questions: who may ask the agent to act, and what the agent can reach. Authentication controls the first. Containment controls the second. Enabling either one does not enable the other.

## Threat model

What DoomPi is built to stop:

| Threat                                                                        | Answer                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------- |
| A web page you visit driving your cockpit through your browser                | Origin and Host checks, upgrades refused            |
| Anyone on the internet reaching a tunnel and using the cockpit                | Pairing, host approval, per-device sessions         |
| A device that pairs once keeping access forever                               | Idle and absolute expiry, revoke, tunnel auto-close |
| The tunnel provider reading or altering what the cockpit carries              | Signed bundle, sealed payload                       |
| A paired device reading the shape of the machine through the cockpit's own UI | Directory scope on the tunnel listener              |
| An agent reaching files nobody meant to expose                                | The container, with mounts as the boundary          |

What it is not built to stop, stated once here and again at the end: a compromised container engine,
a hostile process already running as you, a bad model given a good prompt, or the agent destroying
the repository it was handed.

## Loopback is not an authorization boundary

The cockpit bound `127.0.0.1` and treated that as sufficient. It is not, for three reasons, and two
of them were live holes before the guard landed.

Any process on the machine can reach a loopback port. That much is obvious and was always accepted.

A WebSocket upgrade is exempt from CORS. A page on any origin could open a socket to the cockpit and
drive a session, and the browser would neither ask nor tell. This is cross-site WebSocket hijacking,
and it needed no tunnel to work.

A cross-origin `POST` with `Content-Type: text/plain`, or a `fetch` in `no-cors` mode, skips the
preflight entirely. The response is unreadable to the attacker, but the request happens, and for an
endpoint that spawns a session the response was never the point.

Both are closed now, on the loopback listener as well as the tunnel one, because a fix that only
applied when remote access was on would have left the default configuration exposed.

## The listener is the boundary

One Hono app runs behind two sockets. The loopback listener is open to whoever already has an
account on this machine. The tunnel listener faces the public internet, and everything arriving
there must prove it holds a paired session.

The discriminator is the socket a request arrived on, read from the connection's own local port. It
cannot be a header: `cloudflared` connects from `127.0.0.1` exactly like every local client, and
there is no header a remote caller cannot set. It is phrased as allow-only-if-provably-local, so a
missing value, an unreadable port, or a socket torn down mid-request all resolve to `tunnel` and
therefore require a credential. The mirror-image phrasing fails open on every one of those.

The guard is the first middleware on the app. Hono composes matching handlers in registration order,
so a guard added after a terminating handler never runs for that path.

### The unauthenticated allowlist

Five routes, matched by exact string equality. No prefix, no wildcard, no path parameter: the
pairing status endpoint takes its id in the query string precisely so the list never needs one. A
contract test pins the count, so a sixth cannot arrive without a reviewer seeing it.

| Route                                           | Why it cannot require a session                  |
| ----------------------------------------------- | ------------------------------------------------ |
| `GET /pair`                                     | The page a scanned QR opens                      |
| `POST /api/remote/pair`                         | Where that page posts the code                   |
| `GET /api/remote/pair/status`                   | Polled until the host answers                    |
| `POST /api/remote/passkeys/authenticate/begin`  | Hands out a challenge, which is public by design |
| `POST /api/remote/passkeys/authenticate/finish` | Proving a passkey is how a device gets a session |

The two passkey routes are there of necessity. Requiring a session to reach them would mean a
registered passkey could never be used and every return visit would need a fresh QR. Neither is a
hole: the second succeeds only for a caller holding a registered credential's private key, which is
the definition of authenticating rather than a way around it.

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

Scanning does not pair anything. It raises a request the host must approve, on the host's own screen,
within three minutes. An approved request stays collectable for twice that window, so a host
approving in the last second still reaches the phone's next poll, and it can be collected exactly
once.

Guessing is not the threat at 256 bits; a scripted attempt being quiet is. Ten wrong codes a minute
is the limit, so the eleventh is refused, and fifty failures across the life of a tunnel close the
tunnel and say so.

The address Cloudflare's edge reports is displayed next to the request and never gates a decision.
Any local process can reach the tunnel listener directly and set that header to anything.

### Sessions

Redeeming an approved request mints a 256-bit token. Only its SHA-256 is retained, so the store is
useless to anyone who reads it. It travels as `__Host-doompi_device`, and the prefix is the point:
the browser refuses the cookie unless it is `Secure`, `Path=/`, and `Domain`-less, so no sibling
subdomain can read or overwrite it. `Secure` is a constant in the code rather than derived, because
`cloudflared` forwards plaintext and `x-forwarded-proto` is attacker-controllable.

Session expiry is off by default. While it is off, the server accepts a paired session until the device is revoked or remote access is disabled; the browser cookie still has a thirty-day ceiling. When expiry is enabled, the configured idle and absolute limits both apply. Disabling remote access revokes every device, closes remote sockets, and clears pending pairing state.

### Passkeys

Where the tunnel has a stable hostname, a device can register a discoverable credential and sign in
without another QR. The relying party id is derived from the configured hostname and nothing else,
never from a request header, because `rpID` is the entire scope of a credential.

Three hostnames are refused rather than accepted and regretted: a quick tunnel, whose hostname
rotates on every start, so a passkey registered now would silently stop working on the next one; an
IP address, which WebAuthn rejects in the browser rather than here, which is a much worse place to
find out; and anything without a dot. Signature counters are checked, so a cloned authenticator is
detectable.

### Step-up

Three actions ask for a fresh gesture on top of a live session, because each one widens what the
session can reach: `provider.login`, `provider.logout`, and `session.create`. The assertion travels
in `x-doompi-assertion` and its challenge is good for sixty seconds.

## Keeping the relay out of it

Cloudflare terminates TLS at its edge. Without further work it reads, and can rewrite, everything
the cockpit carries. Two layers narrow that, both in `@agimon-ai/doompi-web-security`.

### The bundle is signed

Every other guarantee here rests on the page being the page this hub built. A swapped bundle reads
the session cookie, drives the socket, and completes a passkey ceremony on the attacker's behalf.

The hub holds an ECDSA P-256 key at `~/.doompi/web/signing.json`, mode `0600`, and serves a signed
manifest of every asset with its SHA-256. The signature covers a hand-rolled canonical encoding,
sorted and one line per asset, rather than `JSON.stringify` of an object whose key order is an
implementation detail. The page verifies it and pins the key. A cockpit signed by a different key is
refused with a full-screen stop rather than a dismissible warning, because if the page is not the
page this hub built then nothing rendered under it can be trusted.

A check that could not run is not a failure. A browser without WebCrypto, or with storage denied,
renders the cockpit without this verification rather than refusing to render at all.

### The payload is sealed

The QR carries an ephemeral P-256 public key alongside the pairing code, in the URL fragment, which
no browser sends to any server. The device completes an ECDH against it and both sides derive
AES-256-GCM keys through HKDF-SHA256, separately per direction. Socket frames and API bodies then
travel as ciphertext.

Nonces are twelve bytes: a four byte random prefix and an eight byte counter. At 2^32 messages the
channel refuses to seal any more rather than reusing a nonce, which for AES-GCM is the failure that
loses the key. A receiver rejects any counter it has already passed, so a replayed frame is refused
rather than decrypted. Sends go through a serial queue, because two async seals racing would take
counters in one order and reach the wire in another, and the second to arrive would be read as a
replay of the first.

Because the host key arrived on a screen rather than through the relay, there is no moment at which
the relay could substitute its own. This is the job Telegram's emoji comparison does for a secret
chat, done automatically instead of by eye.

**A plugin that calls `fetch` directly sends plaintext to the relay.** Plugins use
`sealedTransport.fetch` from that package's `./browser` subpath, which the plugin import allowlist
admits for exactly this reason. The host cannot enforce it, which is why it is written down here.

## Narrowing what is in reach

### Directory scope

While a tunnel is up, the new-session picker answers a request arriving on it from the directory
`doompi-web` was started in and no further. Unpinned, that route hands a paired device a map of the
machine: every project, every client name, every checkout, which is worth more to an attacker than
most of what the cockpit shows.

Only that request. The local picker is untouched, because the person at the keyboard already has a
shell and pinning them would cost the picker its usefulness for nothing. A contained cockpit needs
none of it, because its mounts are already the boundary.

This ends casual enumeration, not directed access. `POST /api/sessions` still accepts any absolute
path a caller already knows, which is what the container below is for.

### The container

Off by default, and tied to remote access rather than offered separately: containment is only worth
anything if it is in place before the tunnel is.

One container holds everything: the hub, every session server it spawns, every agent, and
`cloudflared`. Not one per session. The reason is a security property rather than a convenience.
With the hub inside, `POST /api/sessions` can only name a path that is bind-mounted, so spawning in
an arbitrary directory is closed by construction rather than by a validation check a later refactor
could weaken.

The configured workspaces are mounted at their identical host paths, so absolute paths keep
resolving. Home is a named volume, `doompi-cockpit-home`, which is where the signing key and the
credential store live; they have to survive a restart, because a changed signing key would make
every paired device refuse the cockpit. Deliberately absent: the host home directory, `~/.ssh`,
`~/.gitconfig`, the container socket, and every repository not listed.

`DOOMPI_SANDBOX_DEVCONTAINER=0` is forced. A workspace carrying a dev container configuration would
otherwise replace the whole plan with an author-controlled one that can mount anything, including the
container socket. That mode is a convenience elsewhere in DoomPi and is documented as such; silently
inheriting it here would make the containment claim false.

One port is published, `127.0.0.1:<port>:<port>`, with the hub binding `0.0.0.0` inside because the
engine forwards to the container's external interface rather than its loopback.

Two things cross the boundary and nothing else does. Provider credentials go through the existing
broker, which hands the container a per-session token in place of every real key and withholds
credentials for providers it does not carry. Git identity is passed as `GIT_AUTHOR_*` and
`GIT_COMMITTER_*`, so an agent can commit and cannot push, because no key crosses.

The handover happens on the same port. The host answers the request in full before it stands down,
then starts the container and recreates the sessions working inside a mounted workspace. Sessions
working anywhere else are named in the terminal and left on the host, where the contained cockpit
cannot see them. A container that fails to start rolls back to the host cockpit, sessions and all.

## Defaults

Remote access, tunnel auto-close, session expiry, and containment are opt-in. Host approval is always required for a new pairing.

| Setting           | Default | Why                                                                                                   |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| Remote access     | off     | Nothing is reachable beyond loopback until it is enabled                                              |
| Tunnel auto-close | off     | A tunnel remains open until closed or the hub restarts                                                |
| Session expiry    | off     | Server sessions remain valid until revocation or remote shutdown; the cookie has a thirty-day ceiling |
| Container         | off     | Containment requires a container engine and an explicit workspace list                                |
| Host approval     | always  | Scanning a code creates a request; it never pairs a device by itself                                  |

## What an attacker still gets

Named rather than buried, because a boundary you have not stated the limits of is a claim rather
than a boundary.

- **The container engine is part of the trusted base.** Anyone who can talk to the daemon can escape
  any container it runs. This does not defend against a compromised engine or a user in the `docker`
  group.
- **`DOOMPI_SANDBOX_RUN_FLAGS` validates shape, not meaning.** It accepts any `--flag=value`, so
  `--volume=/:/host` passes. It is an operator escape hatch, not a boundary.
- **Sessions share one container** and can read each other's mounted workspaces. Session-to-session
  isolation is out of scope; one boundary against the host is the point.
- **A mounted workspace is fully writable.** The agent can still destroy the repository it was given.
  The container protects everything else, not that.
- **Network access is unrestricted**, as it already is for `doompi --sandbox`. An agent can reach
  anything the host can reach.
- **The relay still sees traffic shape.** Timing, message sizes, and connection patterns survive the
  sealed channel.
- **The first page load is trust-on-first-use.** The pairing page itself is delivered by Cloudflare.
  Nothing inside a browser can close that window, which is the strongest argument for the WebRTC
  transport recorded in the `doompi-web` README.
- **A local process can do all of this anyway.** None of the above is aimed at code already running
  as you, and none of it should be read as if it were.

## Where the code is

Kept short on purpose: a security claim you cannot check is a slogan.

| Concern                     | File                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| Listener, origin, allowlist | `packages/clients/doompi-web/src/services/remoteGuardPolicy.ts`  |
| The guard middleware        | `packages/clients/doompi-web/src/adapters/remoteGuard.ts`        |
| Pairing handshake           | `packages/clients/doompi-web/src/services/pairingFlow.ts`        |
| Device sessions             | `packages/clients/doompi-web/src/adapters/deviceAuth.ts`         |
| Passkeys and step-up        | `packages/clients/doompi-web/src/services/webauthnPolicy.ts`     |
| Bundle signing              | `packages/core/doompi-web-security/src/adapters/bundleSigner.ts` |
| Sealed channel              | `packages/core/doompi-web-security/src/types/sealedChannel.ts`   |
| Container plan              | `layers/sandbox/doompi-sandbox/src/services/cockpitPlan.ts`      |

The policy files are pure and have no I/O, so the whole trust boundary is readable in one sitting
and testable without a server. That is why they are shaped that way.
