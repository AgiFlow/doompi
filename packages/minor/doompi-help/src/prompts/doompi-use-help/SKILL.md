---
name: doompi-use-help
description: Use Doom Pi Help to activate package guidance, load exact-version skills, and diagnose unavailable or conflicting contributions.
---

# Use Doom Pi Help

Use Help when a question depends on the installed Doom Pi packages and their current authoring or usage guidance.

## Activate guidance

1. In an interactive Doom Pi session, use `SPC h e` to toggle Help.
2. In standalone Pi, run `/doom-help`.
3. In a headless host, invoke Help through the shared minor-mode catalog.
4. Read the skills that appear after activation, then select the narrowest skill for the task.
5. Deactivate Help when the package guidance is no longer needed.

Help resolves package-owned `llms.txt` indexes from the installed package, an immutable exact-version cache, or an integrity-verified exact-version registry fallback. Treat the resulting skills as guidance for the installed version, not for an unspecified latest release.

## Diagnose activation

- If Help remains inactive, inspect the first reported diagnostic and verify that at least one package contributed a valid index and skill.
- If one package fails but others load, continue with the loaded skills and report the degraded source separately.
- If skill names collide, the contribution from the earlier package source wins and Help records a diagnostic for the duplicate.
- If no source can load, do not invent package guidance. Report the activation failure and use verified local package documentation instead.

Deactivation removes active Help skills immediately. Cached files may remain on disk, but they are not active model context.
