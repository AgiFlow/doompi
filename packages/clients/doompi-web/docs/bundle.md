# DoomPi bundle resolution

DoomPi Web resolves one complete bundle for each session. A bundle is an immutable sync generation containing:

- the precompiled DoomPi runtime and sync state
- the cockpit web assets
- the generated web plugin composition and manifest
- the generated package API route directory

A registration is usable by DoomPi Web only when all required artifacts exist. A registration with no web directory is a CLI-only generation, not a web bundle.

## Resolution order

Bundle resolution is session-scoped:

1. Resolve the session working directory to its Doom configuration root.
2. Try the synchronized bundle registered for that repository or worktree.
3. If the repository bundle is missing, incomplete, invalid, or fails to synchronize, use the synchronized global bundle from `~/.pi/.doom`.
4. If neither bundle is usable, report the synchronization failure. Never select a partially published generation.

This order applies consistently to the DoomPi runtime, web plugins, hub channels, and package APIs. Repository artifacts must not be mixed with global artifacts inside one selected bundle. The global bundle is the fallback, not an additional repository layer.

## Optional package contributions

A package is not required to provide a web plugin or a package API.

- Missing `doompiWeb` means the package contributes no browser plugin or hub channel.
- Missing package API metadata means the package contributes no hub or session API.
- An empty composition still produces valid plugin composition and manifest files.
- An empty API composition still produces valid `hub.routes.mjs` and `session.routes.mjs` files.

Malformed optional metadata or a declared entry that is unavailable is reported with the owning package and skipped when it is safe to isolate. It must not prevent unrelated package contributions or the base cockpit from being bundled. A failure in the DoomPi Web host package itself remains fatal because the base cockpit would not be valid.

## Publication invariant

Synchronization stages every artifact in a new generation before publishing its registration. Publication is atomic. Readers continue using the previous complete generation until the replacement is ready.

DoomPi Web asks drift detection to require a web bundle. This prevents the sync pipeline from treating a CLI-only generation as current. If repository synchronization still cannot produce a complete bundle, session launch continues with the complete global bundle.
