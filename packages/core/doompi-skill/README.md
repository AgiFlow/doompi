# @agimon-ai/doompi-skill

The session skill catalog for [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi).

Pi loads skills from the directories it is given at startup. DoomPi adds two things on top: skills
that are discovered lazily rather than loaded eagerly, and a registry where other extensions
publish their own skill directories.

## What it registers

| Surface              | Behavior                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `/skills`            | a fullscreen browser over everything this session loaded and everything any other domain would add |
| `SPC e s`            | the leader binding for the same browser                                                            |
| `input` hook         | expands `/skill:<name>` for a skill that was discovered but not loaded                             |
| `before_agent_start` | appends discovered skills to the system prompt, and surfaces discovery diagnostics once            |

## Deferred discovery

Scanning every skill directory is the slowest thing this package does, so it does not block the
session. Discovery starts on `session_start` as a numbered generation and is awaited only when
something needs the result. A reload starts a new generation; a snapshot that arrives from a
superseded one is discarded rather than shown, which is what keeps a fast reload from printing stale
diagnostics.

## Contributing skill directories

The package provides the session-owned `doom/skill-sources` Cordis service from
`@agimon-ai/doompi-extension-contracts/skills`. Extensions register their directories inside
`ctx.inject([DOOM_SKILL_SOURCES_SERVICE], ...)`; the returned handle is disposed automatically when
either the contributor or provider unloads. Contributions are keyed by source, so a replacement
generation takes the previous package slot without doubling it.

## Help guidance

While the Help minor mode is active, this package contributes `doompi-author-skill` for creating
and distributing skills and `doompi-use-skill` for browsing, invoking, and diagnosing them. Both
prompts are published under `src/prompts` and routed through this package's [`llms.txt`](./llms.txt).

## Installation

DoomPi depends on this package and activates it as fixed host core, so a DoomPi install already has
it. It is not selectable from `.doom/modes.yaml`.

## License

MIT
