# @agimon-ai/doompi-profile

Persona and environment profile switching for [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi)
sessions.

A **profile** is one of the four axes of a DoomPi selection, alongside domains, the major mode,
and the minor modes. It names a persona directory and a set of environment defaults:

```yaml
# .doom/profiles.yaml
profiles:
  roots: [agents]
  entries:
    reviewer:
      persona: agents/reviewer
      env:
        REVIEW_STRICTNESS: high
```

The persona is `profile.md`, `SOUL.md`, and `AGENTS.md` concatenated from the named directory. The
harness assembles them into one file in the run directory and records its path; the persona entry
appends that file to the system prompt on every agent start, so the repository's own `AGENTS.md`
keeps applying underneath it.

## What it registers

| Entry                  | Surface                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `./extensions/pi`      | the `/profile` command, which lists profiles, switches persona and environment, then reloads |
| `./extensions/persona` | a `before_agent_start` hook that appends the active persona to the system prompt             |

DoomPi uses two entries because a detached child session needs the persona but has no transition
coordinator to run a switch through. DoomPi activates `./extensions/pi` in the parent and
`./extensions/persona` in both.

## Switching

`/profile` plans the change through the session's transition coordinator before applying anything.
A profile change is always a `pi-reload`: the extension set does not change, but module-level caches
have to be dropped so every extension re-reads the environment. Active minor modes are captured
before the reload and restored after it.

## Configuration

Personal profiles load from `~/.pi/.doom/profiles.yaml`, then repository profiles load from
`.doom/profiles.yaml`. Roots discover either one persona folder or direct-child persona folders.
Explicit entries provide a persona path and optional string environment defaults. Resolution runs
from personal discovery to repository discovery, then personal explicit entries to repository
explicit entries. A later profile replaces an earlier profile with the same name.

Persona paths must stay inside the declaring config's `agents/` directory or a profile root from
that same file. Directory and persona-file symlinks cannot escape those boundaries. See the
shipped [profiles contract](./src/prompts/doompi-author-profile/references/profiles-contract.md) for
the full configuration model and verification steps.

## Help

The package registers `doompi-author-profile` with the session's `doom/help` Cordis service. Its
package guidance becomes visible to the AI only while the parent Help minor mode is active. The
registration follows the Help provider lifecycle and is withdrawn when this package or the provider
is disposed.

## Installation

DoomPi depends on this package and activates it as fixed host core, so a DoomPi install already has
it. It is not selectable from `.doom/modes.yaml`.

## License

MIT
