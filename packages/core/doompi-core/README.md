# Doompi core

Reusable runtime logic for Doompi packages. Main and child systems own session lifecycles; the kernel owns contribution selection. `extensions` defines Pi, server, and web plugins, `pi` integrates Pi, `server` hosts APIs and transports, and `web` contains browser capabilities. Shared test hosts and scenarios live under `testing`.

The `doompi` package composes these capabilities into the CLI and distribution. Feature packages own their policies and depend on core.
