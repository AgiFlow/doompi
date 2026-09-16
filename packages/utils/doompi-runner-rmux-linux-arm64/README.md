# @agimon-ai/doompi-runner-rmux-linux-arm64

Prebuilt RMUX runtime for ARM64 Linux (`linux-arm64`).

> **Alpha:** native artifact for the current DoomPi alpha release line.

[`@agimon-ai/doompi-runner`](https://www.npmjs.com/package/@agimon-ai/doompi-runner)
declares this package as an optional dependency. npm selects the package that matches the host OS
and CPU, so install Runner rather than installing this artifact directly.

The package contains the native RMUX executables used for process supervision, built from upstream
tag [`v0.9.1`](https://github.com/Helvesec/rmux/releases/tag/v0.9.1) at commit
`fb827cd7adf206995bab274aeafc58ddd09ac5b5` of [Helvesec/rmux](https://github.com/Helvesec/rmux). It
exports only its package metadata and has no JavaScript runtime API.

RMUX is a general-purpose terminal multiplexer, so it carries features DoomPi never calls, including
its `web-share` remote pane sharing. DoomPi Runner invokes only session and pane supervision. See
[Trust and data boundaries](https://github.com/AgiFlow/doompi/blob/main/docs/trust-and-data-boundaries.md)
for the full boundary. Native Linux ABI compatibility still
depends on the host libc and system environment; a matching CPU alone is not sufficient. Runner
also expects `/bin/bash`.

Part of the composable [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

## License

MIT OR Apache-2.0
