---
name: doompi-use-skill
description: Use DoomPi's skill catalog and deferred discovery. Use when browsing available skills, invoking /skill:name, understanding Help and extension-owned skill groups, or diagnosing why a skill is absent or shadowed.
---

# Use DoomPi skills

Open the skill browser with `/skills` or `SPC e s`. The catalog groups normal session skills, package Help skills, plugin skills, and extension-contributed directories by owner.

Invoke a skill with `/skill:<name>`. DoomPi expands deferred skills before Pi handles the input, so a skill can be invokable even when its full body was not placed in the initial prompt. Help skills appear only while Help mode is active.

When a skill is missing:

1. Confirm its owning package, plugin, domain, or Help mode is active.
2. Wait for deferred discovery to finish by opening `/skills` or invoking the exact skill.
3. Check the browser diagnostics for unreadable `SKILL.md` files, invalid frontmatter, duplicate names, or unavailable Help resources.
4. If two sources use the same name, remember that normal loaded and deferred skills take precedence over Help skills.
5. After changing domains or package composition, reload or relaunch as requested so the session receives the new skill directories.
