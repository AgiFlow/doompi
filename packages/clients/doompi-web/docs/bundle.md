# Web bundling and serving

DoomPi Web does not bundle the TUI. The TUI loads a Node.js runtime composition prepared by DoomPi. The web build uses the same selected packages to produce browser plugins, hub channels, and HTTP APIs for the cockpit.

Read [Composition and runtime bundling](../../../../docs/bundling.md) first if the DoomPi composition, fingerprint, or synchronized generation is unfamiliar.

## The design in one picture

```text
DoomPi composition for a repository
                |
                v
          doompi sync
                |
        +-------+--------+
        |       |        |
        v       v        v
 browser plugin JS   hub channels   package APIs
 and CSS              registry       route modules
        |                  |              |
        +--------- immutable generation --+
                           |
                 selected per session
                           |
        +------------------+------------------+
        |                                     |
        v                                     v
 package-owned browser shell              DoomPi Web hub
 loads verified plugin assets             loads server modules
```

There are two deliberately separate browser pieces:

- **The shell** is the cockpit application shipped by `@agimon-ai/doompi-web`. It owns navigation, sessions, the timeline, the composer, settings, and the plugin runtime.
- **The plugin composition** is generated from the DoomPi packages selected for one repository. It contributes the tabs, renderers, channels, settings, and other surfaces those packages declare.

The shell stays stable while the plugin composition changes with the focused session.

## Why it is built this way

### One hub can serve different repositories

A DoomPi Web hub can attach to several `doompi-server` processes. Each session has its own working directory, and those directories may belong to repositories with different modes and package sets.

Building plugins into the shell selected at hub startup would give every session the same UI. Instead, the hub resolves a plugin composition from each session's repository and tells the browser which composition belongs to the focused session.

### Browser code is compiled ahead of time

A plugin client entry may contain TypeScript, React, CSS, and Tailwind classes. The browser should not discover packages or compile source code. `doompi sync` does that work ahead of time with Vite and writes ordinary JavaScript and CSS into the synchronized generation.

This also gives sync one place to validate plugin manifests and client imports. A malformed optional plugin can be reported and skipped before a user opens the cockpit.

### Client and server code stay apart

A web plugin can have two entries:

- `webPlugin` is browser code and is compiled into the client composition.
- `webHubChannels` is Node.js code and remains a built server module loaded by the hub.

Package APIs are server modules too. They are generated into separate hub and session route registries. Server paths and implementations never need to be placed in the public browser asset directory.

### Shared browser runtimes have one owner

The plugin composition does not ship its own copies of React, TanStack Store, CodeMirror, the web component library, or the browser security runtime. Vite marks those packages as external and the shell supplies its copies through the plugin runtime global.

This is more than a size optimization. React and CodeMirror objects must come from compatible singletons, and the sealed transport must keep one set of nonce counters. Loading a private copy per plugin would break those contracts.

### Publication is complete before selection

Sync writes a new immutable generation and publishes its registration only after all required artifacts validate. The hub therefore selects one complete generation for a session. It never combines a repository's client code with a global hub registry or API directory.

## What `doompi sync` builds

For the selected package roots, the web bundler scans each `doompiWeb` manifest and generates client imports and a server registry. Vite then creates:

```text
<generation>/
  web/                       full synchronized SPA retained for compatibility
  plugins/
    composition.js           browser plugin definitions
    manifest.json            Vite output manifest
    assets/...               plugin CSS and other emitted assets
  generated/...              generated source entries used during the build
  webPlugins.server.json     built hub entry paths, not a public browser asset
  pluginRoots.json           roots used by the development server
  api/
    hub.routes.mjs           generated hub API registry
    session.routes.mjs       generated session API registry
```

The current runtime serves the package-owned shell by default. The synchronized `web/` directory remains part of the generated contract and can be selected explicitly, but it is not automatically substituted for the shell. The session-specific output is `plugins/`, `webPlugins.server.json`, and the API directory.

An empty plugin or API composition is valid. Missing optional metadata means the package contributes nothing to that surface. Invalid optional entries produce notices and are skipped when they can be isolated. A missing host shell or incomplete required generation is not treated as an optional plugin failure.

## How a session selects its composition

When a session appears, the hub uses its working directory to find the nearest DoomPi configuration root:

1. Read the synchronized registration for that repository or worktree.
2. Confirm that its plugin entry and manifest exist.
3. Use that complete repository generation when available.
4. Otherwise try the hub's complete global synchronized generation.
5. If neither has plugin artifacts, keep the package-owned shell with its built-in surfaces.

The global generation is a web fallback, not another layer. Once a repository generation wins, its client composition, hub channels, and package APIs stay together.

The hub derives a composition ID from the registration root, generation, and state hash. Sessions with the same synchronized composition can share the same published browser assets, while different generations receive different identities.

## How the hub serves it

### The shell

The normal listener serves the shell built into `@agimon-ai/doompi-web`. `--assets <path>` or `DOOMPI_WEB_DIST` is an explicit operator override. `DOOMPI_WEB_PACKAGE_ROOT` exists for packaged launchers whose files do not have the normal npm layout.

### Browser plugins

The hub copies the selected `plugins/` output into its immutable publication store and signs a manifest containing each path, content type, byte length, and SHA-256 digest. It exposes raw publication bytes under composition- and revision-specific routes.

The shell build also emits `bundle-asset-policy.json`. Vite derives it from original module ownership and emitted resource references, not hashed filenames. Only output exclusively owned by the known PDF or Mermaid graph, including the PDF worker resource, is optional. Shared and unclassified output stays in the required core. The signer includes this compact policy as a regular manifest v2 asset, so no manifest migration is needed.

For the shell, the service worker first verifies the policy bytes. Missing or unsupported policy data falls back to eager activation. It revalidates matching bytes from the previous cache, fetches only missing or changed core assets with a four-request pool, and atomically commits a unique staging cache after all core checks pass. Reusable optional bytes are retained when possible, while the previous complete cache remains available for rollback and legacy offline use.

An uncached optional shell asset is fetched only when requested. The worker resolves the exact path in the captured signed manifest, deduplicates concurrent misses, fetches revision-specific bytes, verifies them, and caches them before responding. It never serves an unlisted or unverified fallback. If that revision has already been superseded, one verified refresh uses the existing update notification and page reload path. Offline misses keep the feature's existing fallback or error state until reconnect and reload.

Plugin composition delivery is unchanged. The browser does not execute plugin raw URLs directly. Its service worker verifies the signature and every plugin asset, commits the complete composition to Cache Storage, and exposes a verified local route. Only then does the shell load `composition.js` and its styles. Switching sessions activates the verified composition assigned to that session and disposes the previous session's plugin UI.

A failed verification, download, or required cache write leaves the previous verified revision in place. Assets from two revisions are not mixed. Session data and private file bytes never enter these caches.

### Hub channels

`webPlugins.server.json` sits beside the public build output. It names each plugin's built hub module by absolute path. The hub imports those modules lazily for the selected session composition. A missing or broken optional module produces a notice and omits its channel instead of crashing the cockpit.

### Package APIs

`hub.routes.mjs` runs package APIs in the web hub. `session.routes.mjs` is loaded by `doompi-server`. A request with `hubSession=<session-id>` selects the hub API registry belonging to that session's web composition. A request with `session=<session-id>` is proxied to that session server. See [Package APIs](package-apis.md) for the routing contract.

## Local and remote serving

Local and remote clients use the same selected composition, but remote delivery has an extra trust problem: the tunnel provider terminates TLS.

For an installed remote PWA, the QR pins the host signing key and a minimum shell revision. The service worker verifies both the package-owned shell publication and each per-session plugin publication before execution. Pairing pages and the first service worker still come from the tunnel origin, so this is not independent authentication of the initial bootstrap. See [Remote security](security.md) for that boundary.

The server-side registry and API modules are never signed for browser delivery because they are never served as browser assets.

## When changes take effect

| Change                               | Required action                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| Web plugin client source or manifest | Build the package, run `doompi sync`, then create or restart the session                 |
| Hub channel entry                    | Build the package, run `doompi sync`, and restart the hub or affected session attachment |
| Session package API                  | Build, sync, and restart the session server                                              |
| Hub package API                      | Build, sync, and reload the selected hub API composition                                 |
| Package-owned shell                  | Rebuild or upgrade `@agimon-ai/doompi-web`, then restart the hub                         |
| Global synchronized composition      | Run `doompi sync`; the global watcher adopts completed generations                       |
| Repository selected with `--dir`     | Run `doompi sync`, then create or restart a session; `--dir` is not a file watcher       |

For client development, the Vite server can generate the composition from `DOOMPI_WEB_PLUGIN_ROOTS` and hot reload browser entries. Hub entries remain built Node.js modules and require a package build plus a hub restart.

## The terms to keep separate

| Term                   | Meaning                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| DoomPi composition     | Ordered Pi extension activation plan for a repository and selection            |
| Runtime bundle         | Node.js entry loaded by Pi for the TUI                                         |
| Web plugin composition | Browser JavaScript and CSS generated from packages with `doompiWeb`            |
| Hub registry           | Private list of server-side `webHubChannels` modules                           |
| Package API registry   | Generated hub or session HTTP handler modules                                  |
| Signed publication     | Immutable shell or plugin bytes offered to the service worker for verification |

They share a synchronized generation so they cannot drift independently, but they are different artifacts loaded by different runtimes.
