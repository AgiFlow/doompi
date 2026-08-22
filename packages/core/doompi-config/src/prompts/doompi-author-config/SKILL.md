---
name: doompi-author-config
description: Configure DoomPi runtime settings, source precedence, and typed session configuration. Use for config.yaml, the doom/config Cordis service, immutable context snapshots, or shared selection transition state. Do not use for defining modes.yaml, domains.yaml, or profiles.yaml.
---

# Author DoomPi runtime configuration

Configure runtime policy in `config.yaml` and consume one immutable session snapshot through Cordis.

## Workflow

1. Read both `~/.pi/.doom/config.yaml` and the repository's `.doom/config.yaml` before changing effective settings.
2. Check the `DoomConfig` types and parser before adding or editing a field. Unknown keys and invalid values fail early.
3. Preserve field-specific source policy. Repository settings do not uniformly replace every personal setting.
4. Consume live state only inside an owning `cordis.inject([DOOM_CONFIG_SERVICE], ...)` callback, using `requireDoomConfigContext(cordis)`.
5. Treat `settings`, `harness`, `pendingSelection`, and nested values as immutable. Do not mutate or cache a snapshot across session replacement.
6. Route live major-mode, domain, and profile changes through the transition coordinator. Keep append-only selection and transition entries consistent with the active harness.
7. Keep `process.env` as launcher transport and the controlled live-switch boundary, not as an alternative configuration registry.
8. Verify parsing and merge behavior with Doom Config tests, then exercise `doompi --explain` and a real session when transition behavior changes.

Use the package-owned Major Mode, Domain, or Profile Help skill when the task is to define an axis in `modes.yaml`, `domains.yaml`, or `profiles.yaml`.

Read [references/config-contract.md](references/config-contract.md) for the runtime schema, source merge rules, immutable context, and transition contract.
