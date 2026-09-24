---
name: doompi-use-help
description: Set up and debug DoomPi agents using installed package guidance and scoped, read-only diagnostics. Diagnose missing capabilities before proposing authorized repairs.
---

# Use Doom Pi Help

Use Help for agent setup, configuration, missing capabilities, and debugging the current session. Start from the user's expected behavior and an observed symptom. A skill describes a workflow; it does not grant the tools or permissions mentioned in it.

## Activate and inspect

Toggle Help through the minor-mode menu, `SPC h e`, `/minor help`, or `/doom-help`. The command toggles on both Pi and the web/server host. Activation adds Help-only guidance and diagnostics without replacing the ordinary tool set or changing other modes.

Call `help_status` to inspect the applied Help capabilities and their owners. A pending skill count means discovery has not completed or its consumer is unavailable, not that every registered descriptor is usable. Report degraded contributors separately and continue with healthy contributions. Missing, shadowed, restricted, and unavailable resources are different conditions.

Select the narrowest available guidance and load it only when needed. Do not paste every package manual into the conversation. Pi resolves package indexes against the installed version, an immutable cache, or an integrity-verified exact-version fallback. Server skills point to the installed package's published resources.

## Set up or repair an agent

Use `diagnose_setup` when contributed by the distribution. It checks saved configuration, installed packages, and sync drift for the bound workspace. Its result distinguishes those checks from the applied session selection. It does not test provider authentication, network health, or the quality of an agent run. Parser error text and configuration values are omitted to protect secrets.

Follow the indicated configuration, profile, major-mode, or domain skill. Read both the personal and repository configuration through authorized tools before proposing changes. Explain source precedence and preserve unrelated settings. A saved change may require a separate authorized reload or selection transition before it affects the session.

Configuration edits, package installation, model changes, authentication, permissions, and restarts require the existing approval and execution mechanisms. Present the intended change and verification first. Do not enable a domain, plugin, MCP server, shell, or network permission merely because a diagnostic would be easier with it.

## Debug an agent or a missing capability

Use `diagnose_agent` when the log package contributes it, then read `doompi-debug-agent` for interpretation and deeper investigation. Begin with the current-session one-day window. Empty or unavailable telemetry is not evidence of a healthy run. Token sample coverage is not event-capture completeness.

For a missing tool or skill, inspect its owner, selected domains and modes, discovery status, collisions, and restrictions. Use the available package guidance for MCP, skills, runners, and other features. If the relevant capability is absent, report what is missing and what an operator must check. Do not invent its cause or claim a command ran because its source exists.

Separate observed evidence from hypotheses. After an authorized repair, reproduce the original symptom, inspect the resulting capability or diagnostic state, and report the verified outcome and remaining limitations.

## Leave Help

Deactivate when support guidance is no longer needed. Help-only skills and tools are withdrawn from future discovery and calls. Ordinary capabilities remain subject to their existing restrictions. Cancellation stops supported in-flight Help work but cannot undo completed effects. Previously read guidance and results can remain in conversation history, and cached package files can remain on disk.

Help is a local agent capability. Its activation does not expose these diagnostics to remote MCP clients or widen a remote client's grant.
