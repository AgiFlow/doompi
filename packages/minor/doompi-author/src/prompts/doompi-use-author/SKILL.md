---
name: doompi-use-author
description: 'Use @agimon-ai/doompi-author: Visual steering workspace for focused document review and bounded authoring'
---

# Use Author

Read the package [README](../../../README.md) for its exact installation, command, configuration, and behavior.

## Guidance

- Use `/doom-author` as the package's primary Pi entrypoint.
- Open a named canvas with `open_authoring_file({"path":"relative/file.png","alias":"review"})`. Use the returned canonical alias, which may differ if the file was already open. The opening result does not mean its catalog is ready.
- Call `describe_author_tools({})` to list canvas aliases and readiness, then `describe_author_tools({"alias":"review"})` to read that canvas's latest capability schemas and `catalogToken`. Use `use_author_tools({"alias":"review","catalogToken":"...","name":"...","arguments":{}})` with exactly the advertised arguments. If opening or stale, wait and describe again.
- Returning to the main conversation retains document capabilities while the canvas tab remains open. Grid operations need the matching visible tab and must be rediscovered after a viewport change.
- Treat the package README and its linked resources as the source of truth for package-specific behavior.
- Do not require DoomPi Help for runtime activation. Help only makes this package guidance discoverable while the minor mode is active.
- Autonomous Voice coordinates are evidence, not mutation authority. Call `author_describe_grid`, then `author_resolve_grid_cell` with the returned geometry token and the user's verbatim instruction.
- Mutate only through the resulting `regionId` with `author_apply_region`, passing the expected revision and source digest. Apply multi-region requests sequentially and use the revision returned by each successful mutation for the next region. On `STALE_GRID`, `STALE_DOCUMENT`, or `STALE_REGION`, describe and resolve again.
- Text, Markdown, editable cells, slide text, and image crop support mutation. PDF and video regions are capture-only.
