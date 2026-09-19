# Security policy

DoomPi is alpha software, and its configuration is not just data. Extensions,
remote Git and npm plugins, hooks, MCP stdio commands, workflows, and shell
commands all run code. DoomPi also ships native binaries and can launch other
agent frontends. Read a configuration the way you would read a shell script
before running it.

## Supported versions

Security fixes go into the latest published alpha. Earlier alphas are not patched.

| Version                | Supported |
| ---------------------- | --------- |
| latest `0.0.1-alpha.*` | Yes       |
| earlier alphas         | No        |

## Reporting a vulnerability

Keep security reports out of public issues.

Open this repository's **Security** tab and choose **Report a vulnerability** to
send a private report to the maintainers.

Include the affected version, platform, steps to reproduce, and what an attacker
could do. Send what you have. A proof of concept helps, but is not required.

Expect an acknowledgement within 5 working days. This is a single-maintainer
alpha project, so please allow up to 90 days for a fix before public disclosure.
Tell us about any earlier disclosure plans so we can coordinate.

## Scope

In scope:

- The published `@agimon-ai/doompi*` packages and this repository's source.
- Configuration parsing that lets a repository-level file escalate beyond what its scope should allow.
- The synchronized state written under `~/.pi/.doom/`, and the settings DoomPi writes into Pi.
- The compatibility launchers (`doompi compat`) and what they pass to third-party frontends.

Out of scope:

- Code you configured DoomPi to run. Running configured extensions, plugins, hooks,
  MCP servers, and shell commands is the purpose of the tool, not a vulnerability.
  See [Trust and data boundaries](docs/trust-and-data-boundaries.md).
- Vulnerabilities in upstream projects. Report those to their maintainers: Pi
  (`earendil-works/pi`), RMUX (`Helvesec/rmux`), and RTK (`rtk-ai/rtk`).
- Findings that require an attacker to already have write access to your repository,
  your `~/.pi/` directory, or your shell.

## Bundled binaries

Runner ships prebuilt third-party binaries under
`packages/utils/doompi-runner-{rmux,rtk}-*/vendor/`. [Trust and data
boundaries](docs/trust-and-data-boundaries.md) records where they come from and
what they can do. Report binary vulnerabilities upstream, and let us know so we
can pin a fixed version.
