# DoomPi profiles authoring contract

## Sources and shape

DoomPi reads profile declarations in this order:

1. `~/.pi/.doom/profiles.yaml`
2. `<repoRoot>/.doom/profiles.yaml`

The current catalog shape is:

```yaml
profiles:
  roots: [agents/acme]
  entries:
    writer:
      persona: agents/special/writer
      env:
        BRAND: acme
        TONE: concise
  defaultProfile: writer
```

The document may contain only the `profiles` mapping. In catalog form, `profiles` may contain only
`roots`, `entries` and `defaultProfile`. DoomPi still accepts the earlier flat form, where profile
names appear directly below `profiles`, but new configuration should use catalog form.

`defaultProfile` names the persona a run starts on when nothing else names one, the same way
`modes.yaml` declares `defaultMajorMode` and `domains.yaml` declares `defaultDomains`. A repository
declaration replaces a personal one. `doompi --profile <name>` overrides it for one run, and an
inherited `DOOMPI_PROFILE` wins so a nested run stays on the persona its parent chose. A
`defaultProfile` naming a profile that does not exist fails the launch rather than starting with no
persona.

Every relative root or persona path resolves against the file that declares it. Repository paths
resolve from the repository root. Personal paths resolve from `~/.pi/.doom`.

## Root discovery

Each `profiles.roots` value must resolve to an existing directory.

- If the root directly contains `profile.md`, `SOUL.md`, or `AGENTS.md`, the root is one profile.
  Its directory name is the profile name, and its children are not scanned.
- Otherwise, DoomPi inspects only the root's direct-child directories. A child becomes a profile
  when it directly contains at least one persona file.
- Discovery does not recurse. Add another root or an explicit entry for a deeper persona.
- A discovered profile has an empty environment mapping.
- Unreadable candidates and candidates whose real path or persona files escape the configured root
  are ignored. An invalid configured root itself is an error.

## Explicit entries and path confinement

An explicit entry may contain only `persona` and `env`. `persona` is required, must be a non-empty
relative path, and must resolve to a directory containing readable persona content.

The persona must remain inside either:

- the `agents/` directory beside the declaring repository root or personal `.doom` directory, or
- one of the `profiles.roots` directories declared in that same file.

DoomPi checks both the lexical path and the real filesystem path. A persona-directory symlink cannot
escape an allowed root. Each resolved persona file must also remain inside the real persona
directory, so a file symlink cannot import instructions from outside it. Invalid explicit entries
fail loading instead of being skipped.

Persona content is assembled from non-empty files in this order:

1. `profile.md`
2. `SOUL.md`
3. `AGENTS.md`

## Persona identity front-matter

A persona may open `profile.md` with a YAML front-matter block declaring who it is and how it
sounds. Only `profile.md` is read this way; `SOUL.md` and `AGENTS.md` are always prose.

```markdown
---
name: Rhea
icon: avatar.png
voice:
  voice: Karen
  rate: 175
---

You are Rhea, a blunt systems architect.
```

All three fields are optional. `name` replaces the profile's directory name in the cockpit,
`icon` is an image beside `profile.md`, and `voice` shadows `voice.autoCapture.tts` from
`config.yaml` per field: a persona setting only `rate` keeps the configured voice. The TTS `engine`
is never overridable, because it selects the synthesiser rather than the persona.

Because identity lives here rather than in `profiles.yaml`, it applies to profiles found by root
discovery as well as to explicit entries.

A block is only treated as identity when it is fenced on the very first line, closed, parses as a
YAML mapping, and declares at least one of `name`, `icon`, or `voice`. Anything else is left in the
persona text byte for byte, so a persona that legitimately opens with a horizontal rule is
unaffected. A recognised block is removed from the prompt: it describes the persona rather than
instructing it. A `profile.md` holding nothing but front-matter therefore has no persona text, and
the profile fails to load unless `SOUL.md` or `AGENTS.md` supplies it.

The icon is read once when the profile loads and travels to the cockpit as a `data:` URL, so no
file is served at request time. It must be a PNG, JPEG, GIF, or WebP, checked by content rather
than by file extension. SVG is refused because an SVG rendered in the cockpit executes script. The
icon must stay inside the persona directory under the same real-path rule as persona files, so a
symlink cannot smuggle a file out of it. An icon that is missing, unreadable, of another type, or
larger than 256 KiB once encoded is dropped: the persona keeps its name and the cockpit falls back
to the default avatar rather than failing the profile.

## Precedence

DoomPi resolves names in four passes, from lowest to highest precedence:

1. Personal root discoveries
2. Repository root discoveries
3. Personal explicit entries
4. Repository explicit entries

A later profile replaces an earlier profile with the same name. This means any explicit entry
overrides discovery, including a personal explicit entry replacing a repository discovery. A
repository explicit entry wins over a personal explicit entry. Unrelated names from all sources
remain available, and the final list is sorted by profile name.

## Environment defaults and activation

Every `env` key maps to a string. Applying a profile writes only variables that are not already
exported by the caller. When switching profiles, DoomPi removes a value contributed by the previous
profile only if that value has not since changed, then applies the next profile's defaults.

The `/profile` command resolves the named profile and executes the change through the session
transition coordinator. A profile change uses Pi reload so extensions re-read the environment.
DoomPi assembles the persona into a private run-directory file, and the persona Pi entry appends
that content to the system prompt after reload.

Autonomous voice can switch profiles too. The `profile` voice capability lists the configured
personas and queues a switch, which arrives as `/profile --voice-switch-token=…`. The chosen name
travels in a TTL-bounded handoff rather than in the command text, so an edited transcript cannot be
turned into a switch to a different persona. A spoken switch therefore takes the same reload path
as the command, which is also what lets the new persona's voice take effect: the spoken voice is
read when autonomous voice activates.

## Verification

```sh
pnpm nx test @agimon-ai/doompi-config
pnpm nx typecheck @agimon-ai/doompi-config
pnpm nx test @agimon-ai/doompi-profile
pnpm nx typecheck @agimon-ai/doompi-profile
pnpm --filter @agimon-ai/doompi exec doompi --profile writer --explain
```

Use an actual parent session to smoke-test `/profile` when changing transition, environment, or
persona application behavior.
