# Remote security

DoomPi Web can expose a browser cockpit to a phone through a tunnel. Treat this as access to a local agent that may run `bash`, not as a read-only dashboard. A paired device can drive the agent with the permissions of the account running DoomPi Web.

The controls below reduce accidental exposure and cross-site attacks. They do not turn an untrusted host, user account, tunnel provider, or workspace into a trusted one.

## Local listener

The default listener is `127.0.0.1:7433`. The host and origin guard runs before HTTP routes and WebSocket upgrades. It checks the actual listener, the `Host` header, and an `Origin` when one is present. This helps prevent DNS rebinding and hostile web pages from driving a local cockpit.

A missing `Origin` is accepted for local requests so command-line clients and health probes work. A local program can send its own headers, so these checks are not an authorization boundary against another process running as the same user. Do not use `--host 0.0.0.0` or another public bind as a substitute for remote access. A non-loopback bind is warned about and does not require pairing.

`DOOMPI_WEB_ALLOW_ORIGIN` adds explicit origins to the local development allowlist. It does not authorize a public listener or bypass remote device authentication.

## Tunnel listener

Enabling remote access binds a second loopback listener on an ephemeral port and points `cloudflared` at it. The normal local listener stays separate. The listener split lets the hub identify tunnel traffic even though `cloudflared` connects from loopback.

The tunnel policy accepts the tunnel's reported origin and host. Before the tunnel is considered ready, the hub probes the public pairing page and expects `/api/health` to return `401`. This confirms those routes, not every route or every property of the tunnel provider.

The tunnel listener's unauthenticated allowlist is limited to package-owned pairing, PWA bootstrap, passkey ceremony, and sealed-channel establishment routes. Some handlers on that allowlist still perform their own checks, such as requiring an existing paired device for passkey registration. Direct remote session and protocol WebSocket upgrades require both a device authorization and a purpose-specific sealed channel. Other remote HTTP requests must use the sealed HTTP gateway. A remote request cannot select arbitrary internal routes by bypassing that gateway.

Quick tunnels are temporary. Their hostname rotates on every start, so they cannot provide a stable passkey relying-party ID, durable PWA identity, or reliable Push identity. Use a named tunnel for those features and protect the tunnel account with hardware MFA or a passkey.

## Pairing and device sessions

The host shows a QR URL such as:

```text
https://tunnel.example/pair#c=<code>&k=<channel-key>&s=<signing-key>&r=<revision>
```

The code, ephemeral channel public key, signing public key, and minimum bundle revision are in the URL fragment. Browsers do not send the fragment to the tunnel provider. Manual pairing requires comparing the signing-key fingerprint on both devices.

A code is claimable for 120 seconds. A successful claim creates a pending request that the person at the host must approve or deny within 180 seconds. Approval is required because a QR can be visible in a screen share or over a shoulder. A request is consumed once, and invalid claims are rate limited.

After approval, the browser receives a device bearer cookie named `__Host-doompi_device`. It is `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`, with no `Domain` attribute. Its browser `Max-Age` is capped at 30 days, and optional idle or absolute session expiry can shorten that lifetime. This is not a `doompi-server` attach token. The hub stores a hash of the device token, updates its last-seen time after authenticated requests, and can revoke it. Revocation removes that device's sealed channels and closes its tracked sockets.

Hashing protects persisted state if the state file is copied, but it does not protect against a hostile host owner or process controlling the hub, state directory, browser, or tunnel. Such an owner can observe or alter the running service and should be treated as having access.

Device sessions and pairing requests are process-local. Restarting the hub, disabling remote access, or revoking a device removes active remote access. Optional session expiry is disabled by default. When enabled, the configured idle and absolute limits are evaluated at each request and can invalidate sessions that are already idle.

## Passkeys and step-up actions

Passkeys are available only when the tunnel has a stable named hostname. The relying-party ID is derived from that hostname. Quick tunnel hostnames, IP addresses, and non-public hostnames are refused for passkey enrollment.

Registration and authentication ceremonies expire after 120 seconds. A step-up challenge expires after 60 seconds. When passkey support is available, a fresh gesture is required for these action classes:

- `provider.login`
- `provider.logout`
- `session.create`
- `settings.write`
- `mcp.discover`
- `mcp.authorize`
- `computer-use.activate`

Quick tunnels skip passkey step-up because their rotating hostname cannot provide a stable relying-party ID. These remote actions therefore have the device session as their remaining remote authorization check. Ordinary prompts and tool approvals remain in the normal session flow rather than asking for a biometric gesture on every turn.

## Sealed transport

After pairing or passkey sign-in, the browser and hub establish separate channels for session traffic, protocol traffic, and HTTP requests. The handshake uses ephemeral P-256 ECDH. Keys are derived with HKDF-SHA-256, and messages use AES-256-GCM with separate directional keys and monotonic counters. Altered, unauthenticated, or replayed envelopes are rejected.

The session and protocol WebSockets carry sealed envelopes for remote devices. The sealed HTTP gateway carries the request method, root-relative target, headers, body, status, and response body inside the encrypted exchange. Pairing, passkey, channel bootstrap, `/pair`, `/sw.js`, and other PWA bootstrap assets are intentionally unsealed so a device can establish trust.

A client plugin that calls browser `fetch` directly sends plaintext to the tunnel relay. Plugin code that needs HTTP must use `sealedTransport.fetch` from `@agimon-ai/doompi-web-security/browser`. The host cannot enforce that choice for arbitrary plugin code.

Sealing hides post-handshake payload content from a tunnel provider. It does not hide the page and bootstrap assets, the fact that a device is connected, timing, message sizes, request patterns, or tunnel metadata. Do not use this mode when the tunnel provider is outside the trust boundary.

## Signed bundles and bootstrap trust

The host keeps a signing key in its state directory. A QR pins the public signing key and a minimum bundle revision. The host manifest contains a revision and a SHA-256 digest, byte length, and content type for each asset. The service worker verifies the signed manifest, downloads each raw asset, checks its digest, and commits the complete result to a cache. A failed update keeps the last verified host or plugin composition. Plugin compositions are signed with the host publication key and verified in the same way.

This is a delivery-integrity guarantee after the browser has a trusted signer key and a trusted verifier bootstrap. The initial executable bootstrap, including the pairing page and `/sw.js`, is served by the tunnel origin before the worker can verify anything. A malicious host or edge that replaces that bootstrap can omit the verifier or steal the fragment. Bundle signatures do not independently authenticate the first code delivery. Confirm the displayed key fingerprint through an out-of-band channel when the tunnel or host is not already trusted.

Raw bundle assets and raw plugin assets are served only for the signed revision and manifest entries:

- `/bundle-manifest.json` and `/bundle-assets/<revision>/...` are the host bundle routes.
- `/api/web-plugins/<composition-id>/<revision>/manifest` and `/assets/...` are the raw plugin composition routes.
- `/verified-plugins/<composition-id>/<revision>/...` is a service worker cache path for already verified plugin assets.

Session file previews are bounded and served as no-store responses. They are not placed in the application cache, IndexedDB, signed manifests, or Push payloads.

## Optional container boundary

When the sandbox layer is installed, remote access can hand the cockpit to a container. The hub, spawned session servers, agents, and `cloudflared` run inside it. Only explicitly configured absolute workspace paths are mounted. The host home directory, SSH keys, Git configuration, container socket, and unlisted repositories are not mounted by the cockpit handoff. Provider credentials use the broker's per-session token rather than forwarding host API keys.

The container is a boundary, not a complete sandbox:

- the container engine and anyone who can control its daemon are trusted
- sessions share one container and can read each other's mounted workspaces
- mounted workspaces are writable, so an agent can alter or delete them
- network access is unrestricted
- credentials already present in a mounted workspace can still be used
- plugin tabs use the built-in set until a composition is synchronized inside the container

Choose the workspace list as if it grants full write access to every agent in the contained cockpit.

## Before enabling remote access

1. Keep the main listener on loopback.
2. Use a stable named tunnel only when a durable PWA or passkey is needed.
3. Approve each pairing request on the host and revoke devices that are no longer needed.
4. Enable idle and absolute session expiry for unattended access.
5. Use a passkey or hardware MFA for the tunnel provider and enable step-up support.
6. Use the container boundary for remote work that must not see the rest of the host, while retaining the limits above.
