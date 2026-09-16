---
name: doompi-author-profile
description: Configure DoomPi profile discovery, personas, environment defaults, and precedence in profiles.yaml. Use when creating or changing personal or repository profiles. Do not use for config.yaml runtime settings, modes.yaml, or domains.yaml.
---

# Author DoomPi profiles

Configure a profile as one persona plus optional environment defaults.

## Workflow

1. Read both `~/.pi/.doom/profiles.yaml` and the repository's `.doom/profiles.yaml` when they exist.
2. Use `profiles.roots` for one-level persona discovery. Use `profiles.entries` when a profile needs an explicit persona path or environment defaults.
3. Resolve relative roots and persona paths against the file that declares them. Keep an explicit persona inside that file's `agents/` directory or one of its configured roots.
4. Put instructions in `profile.md`, `SOUL.md`, or `AGENTS.md`. DoomPi concatenates non-empty files in that order.
5. Keep every `env` value a string. Treat it as a default because an already exported value wins.
6. Preserve the precedence rules. Explicit entries override discoveries, and repository entries override personal entries at the same precedence level.
7. Verify the selection with `doompi --profile <name> --explain`, then smoke-test `/profile` when changing live switching behavior.

Read [references/profiles-contract.md](references/profiles-contract.md) before changing discovery, precedence, path handling, or profile application.
