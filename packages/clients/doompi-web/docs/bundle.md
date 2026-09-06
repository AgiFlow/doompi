# Bundle resolution

DoomPi Web treats synchronized output as immutable generations. A usable web registration contains a complete set of artifacts for one configuration root:

- synchronized DoomPi runtime and state
- the host web asset directory
- a generated plugin composition entry and Vite manifest
- a server registry for built hub channel entries
- generated `hub.routes.mjs` and `session.routes.mjs` package API modules

A registration with no web directory is a CLI-only generation and is not a web bundle. A registration is usable only when its web entry, plugin composition entry, plugin manifest, and API directory are present. The hub does not serve a partially published generation.

## Per-session resolution

The selected web composition is resolved for each session:

1. Resolve the session working directory to its Doom configuration root.
2. Read the synchronized registration for that repository or worktree.
3. Use it when the web and API artifacts are complete.
4. Otherwise use the complete global registration from `~/.pi/.doom`.
5. If no complete registration is available, report the synchronization failure and continue with the packaged host shell when it can be served.

The repository registration wins over the global registration even when it is the result of an explicit `--dir` selection. Repository artifacts are never combined with global artifacts inside one session. The global registration is a fallback, not an additional plugin layer.

This selection applies together to the session's plugin client composition, hub channels, and package API bundle. A request with `hubSession=<session-id>` resolves the same registration and dispatches only within its API directory. It cannot borrow an API that is missing from that selected bundle. The `session` query remains the selector for forwarding to the session server's own APIs.

## Synchronization and publication

`doompi sync` stages the runtime, web assets, generated plugin files, hub registry, and API routes in a new generation. It publishes the registration only after the generation is complete. Readers continue using the previous complete registration while the replacement is built.

The hub ensures the global configuration is synchronized at startup and watches only the global synchronization guard. A repository configuration selected by `--dir` is synchronized before launch and before a new or restarted session, but it is not watched. A running session server reads its composition at startup, so restart it after changing synchronized server or API entries.

Optional plugin and API contributions do not make the whole generation invalid:

- no `doompiWeb` field means no web plugin or hub channel
- no `doompiApi` field means no package API
- malformed metadata or an unavailable optional entry is reported and skipped when it can be isolated
- empty plugin and API compositions still have valid generated output
- a failure in the DoomPi Web host package or an incomplete base shell remains a host failure

## Host shell and plugin routes

The packaged host shell is selected separately from the per-session plugin composition. Asset selection is:

1. `--assets <path>`
2. `DOOMPI_WEB_DIST`
3. a synchronized host asset directory when available
4. the package's own built assets

The host signs the active shell publication for the PWA. It exposes its signed manifest at `/bundle-manifest.json`. Raw shell assets are served at `/bundle-assets/<revision>/<asset-path>` and are accepted only for the current signed revision.

Each selected session plugin composition is copied into an immutable publication and signed with a composition ID and revision. Its routes are distinct from raw host assets:

- `/api/web-plugins/<composition-id>/<revision>/manifest` returns the signed plugin manifest
- `/api/web-plugins/<composition-id>/<revision>/assets/...` returns raw plugin assets listed by that manifest
- `/verified-plugins/<composition-id>/<revision>/...` is the service worker's local verified-cache path, not a raw server asset route

Signed manifests include an increasing revision and a SHA-256 digest, byte length, and content type for every asset. The service worker verifies the manifest, then fetches and verifies every raw asset before committing the composition to its cache. Failed updates keep the last verified revision. See [remote security](security.md) for what this proves and what it does not prove.

## Overrides

`DOOMPI_API_DIR` overrides the generated API directory used for the default hub API bundle. The standard generated location is `~/.doompi/api/current`. A session-associated hub API request still uses the selected session registration, unless its registration is replaced by the normal repository-first/global-fallback resolution.

`DOOMPI_WEB_PACKAGE_ROOT` is available to bundled launchers whose built assets do not retain the normal npm package layout. It points the launcher at a package root containing `dist/web` and `dist/pwa`.
