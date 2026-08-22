# Security policy

DoomPi is alpha software. It runs code you configure: extensions, remote Git and npm plugins, hooks,
MCP stdio commands, workflows, and shell commands. It also bundles native binaries and can launch
other agent frontends. Treat a DoomPi configuration the way you would treat a shell script you are
about to run.

## Supported versions

Only the latest published alpha receives fixes. Alpha versions are not patched retroactively.

| Version                | Supported |
| ---------------------- | --------- |
| latest `0.0.1-alpha.*` | Yes       |
| earlier alphas         | No        |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository: open the **Security** tab and choose
**Report a vulnerability**. That creates a private advisory only the maintainers can read.

Include what you have: affected version, platform, reproduction steps, and what an attacker gains.
A proof of concept helps but is not required.

You should get an acknowledgement within 5 working days. Because this is a single-maintainer alpha
project, please allow up to 90 days for a fix before public disclosure, and tell us if you plan to
disclose sooner so we can coordinate.

## Scope

In scope:

- The published `@agimon-ai/doompi*` packages and this repository's source.
- Configuration parsing that lets a repository-level file escalate beyond what its scope should allow.
- The synchronized state written under `~/.pi/.doom/`, and the settings DoomPi writes into Pi.
- The compatibility launchers (`doompi compat`) and what they pass to third-party frontends.

Out of scope:

- Code you configured DoomPi to run. Executing configured extensions, plugins, hooks, MCP servers,
  and shell commands is the documented purpose of the tool, not a vulnerability. See
  [Trust and data boundaries](docs/trust-and-data-boundaries.md).
- Vulnerabilities in upstream projects. Report those to their maintainers: Pi
  (`earendil-works/pi`), RMUX (`Helvesec/rmux`), RTK (`rtk-ai/rtk`).
- Findings that require an attacker to already have write access to your repository, your
  `~/.pi/` directory, or your shell.

## Bundled binaries

The Runner ships prebuilt third-party binaries under
`packages/default/doompi-runner-{rmux,rtk}-*/vendor/`. Their provenance and capabilities are
documented in [Trust and data boundaries](docs/trust-and-data-boundaries.md). Report issues in those
binaries upstream, and let us know so we can pin a fixed version.
