# Desktop security

DoomPi Desktop combines three trust domains: Electron's renderer, a loopback cockpit, and local agent processes. Security depends on keeping their authority distinct. Renderer restrictions reduce the impact of web-content compromise, but they do not contain the cockpit or the agents that the cockpit launches.

## Trust model

```text
untrusted or mixed-origin web content
  │ blocked navigation / external-browser handoff
  ▼
DoomPi renderer
  │ narrow preload contract
  ▼
Electron main process
  │ starts and supervises
  ▼
loopback cockpit
  │ creates sessions
  ▼
agent processes with current-user authority
```

The application trusts its packaged Electron code and staged cockpit runtime. It treats arbitrary renderer navigation as untrusted. The operating-system user remains the ultimate authority boundary for the cockpit and agent processes.

## Renderer containment

The BrowserWindow enables:

- context isolation
- Chromium sandboxing
- disabled Node integration
- disabled webview tags
- an in-memory Electron session partition

The preload exposes only the desktop platform marker and a request for the application version. It does not expose filesystem, shell, process, or general IPC access.

These settings reduce direct access from renderer JavaScript to Electron and Node. They are defense in depth, not proof that the cockpit origin is safe. A renderer compromise can still act with the current cockpit user's web capabilities and send requests available to that origin.

## Navigation and external links

Main-frame navigation is allowed only within the initial cockpit origin. New window creation is denied. A parsed `https:` URL targeting another origin may open in the user's default browser. Other URL schemes are not handed to the external browser.

This keeps external content out of the privileged application window. It does not assess whether an allowed HTTPS destination is trustworthy once opened in the external browser.

## Loopback is a host boundary, not authentication

The desktop cockpit binds to `127.0.0.1`. This prevents direct network exposure on other interfaces, but any process running as the same user can generally connect to the loopback service. Local mode should not be described as authenticated isolation from hostile local software.

Desktop does not add a second authentication system. When remote access is enabled, the web cockpit's pairing, device cookie, passkey step-up, channel sealing, and tunnel policies apply unchanged. Their precise protections and exceptions are documented in [Web security](../../doompi-web/docs/security.md).

## Process authority

The Electron main process, cockpit, session servers, and agents run as the current operating-system user. Agents may read files, run commands, and access credentials available to that user, subject to DoomPi's own tool and package policies.

The renderer sandbox does not extend to those child processes. `ELECTRON_RUN_AS_NODE=1` changes how Electron's executable starts them, not what permissions they receive.

Treat a plugin, layer, or agent package as executable code. Packaged catalogs make code available offline; they do not make that code safe.

## Runtime integrity

Desktop releases stage their runtime instead of resolving core application files from arbitrary workspace paths at startup. Required runtime entries are validated during the build. The bundled `cloudflared` download is pinned and SHA-256 verified.

On macOS, native files and the enclosing application are code-signed, then the release is configured for notarization. These measures provide provenance and tamper detection for distributed artifacts. They do not prevent signed code from misusing user-granted authority or protect an unsigned local development build.

## Computer-use boundary

Desktop contains a bounded host protocol for macOS computer-use operations. Its policy is designed around semantic actions rather than arbitrary shell input, with session-bound grants, expiry, sequencing, and emergency-stop handling. Local and remote approval paths are distinct, and the server remains responsible for remote step-up policy.

The current macOS backend reports Accessibility and Screen Recording permission state but identifies its native adapter as unavailable. Target discovery and activation fail closed because the signed packaged adapter has not passed its capability probe. The existence of IPC handlers or native resources must not be documented as an enabled computer-use feature.

If the adapter is enabled later, operating-system Accessibility and Screen Recording grants will enlarge the application's authority substantially. Renderer isolation alone would not constrain those native privileges. The capability probe, explicit grants, server policy, and audit trail must all remain in the path.

## Data locations

Two storage locations have different purposes:

- `~/.doompi/run`, or `DOOMPI_RUNTIME_DIR`, holds the shared DoomPi session registry.
- Electron's user-data directory holds desktop-owned cache data used by the packaged runtime.

The BrowserWindow session partition is in memory, so Electron does not intentionally persist renderer session storage through a `persist:` partition. This is not a general data-erasure guarantee. The cockpit, browser engine, logs, providers, tools, and agents may write data through their own storage paths.

## Operational guidance

- Install release artifacts only from a trusted distribution source and verify platform signatures where available.
- Keep remote access disabled unless it is required.
- Treat quick-tunnel mode according to the web security guide's documented limitations.
- Review plugins and layers before enabling them.
- Do not grant macOS Accessibility or Screen Recording permissions based only on the presence of the desktop application. The current adapter remains unavailable.
- Use a dedicated operating-system account when agent access must be separated from personal files or credentials.

## Related guides

- [Desktop architecture](./architecture.md)
- [Runtime and packaging](./runtime-and-packaging.md)
- [Web security](../../doompi-web/docs/security.md)
- [Trust and data boundaries](../../../../docs/trust-and-data-boundaries.md)
