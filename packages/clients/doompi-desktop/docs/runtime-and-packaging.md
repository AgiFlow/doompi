# Desktop runtime and packaging

A DoomPi Desktop release is not only an Electron main bundle. It must carry a runnable cockpit, browser assets, the DoomPi CLI, runtime packages, and platform-native helpers. The build assembles those parts into one versioned application artifact while preserving their existing process boundaries.

## Artifact model

The package produces three build directories:

```text
packages/clients/doompi-desktop/
  dist/
    bin/
      main.cjs
      preload.cjs
  build/
    runtime/
      doompi-web/          staged web package and browser assets
      doompi-server/       staged cockpit CLI and server package
      doompi/              staged DoomPi runtime
      node_modules/        runtime packages and platform helpers
      native/              native resolution tree
      catalog/             installable DoomPi package archives
      vendor/              npm, Vite, and cloudflared payloads
  release/                   installer and archive artifacts
```

The exact nested files are build outputs, not public import paths. The stable contract is that the Electron entries live in the application archive while executable runtime resources are copied beside it under Electron's resources directory.

## Build pipeline

### Electron entries

`tsdown` compiles the main process and preload into CommonJS entries. The application manifest points Electron at `dist/bin/main.cjs`.

The renderer is not compiled here. It is the normal `@agimon-ai/doompi-web` build served by the staged cockpit.

### Runtime staging

A Vite SSR build stages the runtime. Its plugin copies the web distribution, server distribution, DoomPi distribution, required package resources, native binaries, and an npm CLI into `build/runtime` before electron-builder assembles the application.

The staging step validates required entry points and executable targets. Missing or ambiguous artifacts fail the build rather than producing a partially runnable desktop application.

A local package catalog is built from the workspace's DoomPi packages. The runtime synchronization path can install the selected DoomPi composition from these packaged archives instead of assuming that the source checkout or workspace `node_modules` exists on the user's machine.

### Native helpers

Platform-native executables and add-ons must remain outside Electron's asar archive because the operating system needs to execute or load them directly. electron-builder copies the entire staged runtime into the application's resources directory, including runner helpers, native Node dependencies, and the Cloudflare tunnel helper.

`cloudflared` is downloaded for the current packaging platform from a pinned release. The download is checked against a platform-specific SHA-256 digest before the file is accepted. The build does not silently substitute an unverified binary.

## One Electron binary, two modes

The cockpit and agent descendants are launched with:

```text
ELECTRON_RUN_AS_NODE=1
```

Electron's executable then behaves as Node for those child processes. This avoids shipping and updating a second Node executable. On macOS, helpers also set `ELECTRON_NO_ATTACH_CONSOLE=1` so Node-mode descendants do not behave like separate dock applications.

This reuse is an implementation choice, not a privilege boundary. The child processes still have normal Node authority under the current user.

## Runtime environment

The launcher constructs a controlled environment for the headless server and presentation proxy:

- packaged server, DoomPi, web, catalog, npm CLI, resource, and binary paths
- selected loopback ports
- `DOOMPI_CLIENT=desktop`
- an agent command that reuses the Electron executable in Node mode
- a short-lived attach token in Electron's user-data directory
- a cache directory inside Electron's user-data directory

Inherited `DOOMPI_*` values are removed before these settings are applied. Provider credentials and unrelated operating-system variables are not part of that prefix and continue to follow the normal DoomPi configuration model.

## macOS signing and notarization

macOS packages contain nested Mach-O binaries. They are signed from the deepest runtime components outward before electron-builder signs the enclosing application. The signing script:

1. discovers staged Mach-O files and native modules
2. sorts them deepest-first
3. signs each file with the configured identity and entitlements

This ordering matters because changing a nested signed file after signing the outer bundle invalidates the enclosing signature.

Release signing and notarization use electron-builder's standard environment inputs, including:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `CSC_NAME`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Local development can build unsigned output. A distributed macOS artifact requires the release credentials and successful notarization.

## Platform targets

The current electron-builder configuration produces:

| Platform | Architecture | Formats       |
| -------- | ------------ | ------------- |
| macOS    | arm64        | DMG, ZIP      |
| Linux    | x64          | AppImage, DEB |
| Linux    | arm64        | AppImage, DEB |

Windows and macOS x64 are not supported release targets. Build producers reject unsupported platform and architecture pairs before producing an artifact.

## Updates and compatibility

The application contains no in-app updater implementation. A new version is delivered as a new whole-application artifact. Documentation and release automation must not imply an automatic update channel until one is implemented and verified.

Because the runtime is staged with the application, the shell, server, DoomPi code, and packaged catalog form one tested desktop generation. User data remains outside the application bundle. Replacing the application therefore replaces its runtime generation without relocating normal user state.

## Tradeoffs

The staged-runtime approach provides repeatable installation and avoids dependence on a source checkout. Its costs are larger release artifacts, platform-specific assembly, nested signing, and duplicated package material inside the artifact.

Using the same headless and web code prevents a desktop-only protocol fork. Its cost is a multi-process application whose readiness and shutdown must be supervised rather than a single renderer process.

## Related guides

- [Desktop architecture](./architecture.md)
- [Getting started](./getting-started.md)
- [Security](./security.md)
- [DoomPi bundling](../../../../docs/bundling.md)
- [Web bundle model](../../doompi-web/docs/bundle.md)
