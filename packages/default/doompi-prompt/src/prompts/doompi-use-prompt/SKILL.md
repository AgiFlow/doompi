---
name: doompi-use-prompt
description: 'Use @agimon-ai/doompi-prompt: Staged recent prompts and saved prompt templates for DoomPi'
---

# Use Prompt

Read the package [README](../../../README.md) for its exact installation, command, configuration, and behavior.

## Guidance

- `/prompts`, or `SPC e p`, opens a filterable picker over the last three prompts of this session and every saved prompt, then stages the chosen one in the editor rather than sending it.
- `/prompt-save <name>` saves the current draft, or the newest staged prompt when the draft is empty, as `~/.pi/agent/prompts/<name>.md`. Names are lowercase letters, digits and dashes.
- A saved prompt is an ordinary Pi prompt template, so it is also `/<name>` from the next start, with `$1` and `$@` argument substitution. Text containing those tokens is substituted on invocation; the save command says so when it sees them.
- Staged prompts live in memory for the session only. Nothing reaches disk until the user saves a prompt explicitly.
- Arrow up and down are Pi's own in-session history and are not modified by this package.
- Do not require DoomPi Help for runtime activation. Help only makes this package guidance discoverable while the minor mode is active.
