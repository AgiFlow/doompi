# DoomPi runtime configuration authoring contract

## Sources

DoomPi loads runtime settings from two files:

1. `~/.pi/.doom/config.yaml`
2. `<repoRoot>/.doom/config.yaml`

An absent file parses as `projectTrust: ask`. Both files reject unknown keys and invalid value
types. Parsing and merge policy live in `@agimon-ai/doompi-config`; packages should not duplicate
that logic.

The runtime file is separate from the three selection-axis catalogs. `modes.yaml` defines major
modes and layers, `domains.yaml` defines content domains, and `profiles.yaml` defines personas.
Consult the Help skill owned by the corresponding package when editing those files.

## Runtime schema

The supported root keys are:

```yaml
projectTrust: ask

modes:
  planning:
    main:
      model: openai/gpt-5.4
      thinking: high
    subagents:
      model: openai/gpt-5.4-mini
      thinking: medium
    plansDirectory: .doom/plans

editor:
  command: code

voice:
  engine: auto
  language: en
  recorder:
    binary: ffmpeg
    device: none:default
  adapters:
    openai-whisper:
      binary: whisper
      model:
        id: turbo

selection:
  majorMode: copilot
  domains: [default]
  profile: reviewer
```

### Project trust

`projectTrust` accepts `ask`, `always`, or `never`. It is repository policy. The repository value
is authoritative, and an absent repository value defaults to `ask` rather than inheriting a
personal value.

### Planning

`modes` may contain only `planning`. `planning.main` and `planning.subagents` accept an optional
non-empty `model` and a `thinking` value from `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`.

`plansDirectory` accepts an absolute path, `~`, `~/...`, or a path relative to the active repository
root. If omitted, it resolves to `~/.pi/plans`. Other home aliases such as `~other/...` are rejected.

This `modes.planning` namespace configures the planning runtime. It does not define major modes from
`modes.yaml`.

### Editor

`editor` may contain only a non-empty `command`. Editor choice is personal, so the effective value
comes from the personal config.

### Voice

`voice.engine` accepts `auto`, `whisper-cpp`, `openai-whisper`, or `mlx-whisper`. `language`, recorder
binary, and recorder device are optional non-empty strings.

Adapters may be declared only for those three concrete engines. An adapter may set a binary and must
set a model containing exactly one of `path` or `id`. `whisper-cpp` accepts only a path. The OpenAI
and MLX adapters accept either form.

Autonomous capture is personal-only and belongs in `~/.pi/.doom/config.yaml`:

```yaml
voice:
  autoCapture:
    model: openai/gpt-4.1-mini
    startPhrases: [hey doom]
    stopPhrases: [stop speaking]
    utteranceIdleMs: 3000
    transcriptionTimeoutMs: 15000
    tts:
      engine: macos-say
      voice: Samantha
      rate: 190
```

The model must use `provider/model-id` form. Control phrases must be non-empty, bounded strings and
must remain unique after normalization. Idle time accepts 1500 through 10000 milliseconds. The
transcription timeout accepts 1000 through 120000 milliseconds. TTS currently accepts only
`macos-say`, with an optional rate from 80 through 500. Repository `voice.autoCapture` is rejected.

### Default selection

`selection` may contain a non-empty `majorMode`, an array of string `domains`, and a non-empty
`profile`. An empty domains array intentionally selects no content domains.

These values choose defaults only. They do not define any mode, domain, or profile.

When a repository declares `selection`, repeat every personal axis that should remain selected.
Parsed omitted keys become unset, so the effective file-loaded selection contains the repository's
declared values rather than inheriting omitted personal axes.

## Source merge rules

Merge behavior is field-specific:

- `projectTrust` comes from the repository parse result. Missing repository configuration produces
  the `ask` default.
- `editor` comes from personal configuration. A repository editor value is not selected.
- `modes.planning.main` and `modes.planning.subagents` merge their fields, with repository fields
  replacing personal fields. Repository `plansDirectory` replaces the personal value when present.
- `voice` merges with repository fields replacing personal fields. Recorder fields merge. Adapter
  binary fields merge, while a repository adapter model replaces the personal model as one value.
- `voice.autoCapture` remains the personal value. Declaring it in repository configuration is an
  error.
- If neither file declares `selection`, it remains absent. When only one file declares it, that
  mapping supplies the defaults. When the repository declares `selection`, its parsed mapping
  replaces personal values for omitted axes as well as axes it sets.

Do not assume one generic deep-merge rule or copy this policy into consumers. Call `loadDoomConfig`
or use the live service snapshot.

## Immutable Cordis context

`@agimon-ai/doompi-config/extensions/pi` provides `DOOM_CONFIG_SERVICE` on the runner's shared Cordis
session branch. Consume it inside an owning injection:

```ts
cordis.inject([DOOM_CONFIG_SERVICE], (configContext) => {
  const snapshot = requireDoomConfigContext(configContext);
  const settings = snapshot.settings;
  const active = snapshot.harness;
  const pending = snapshot.pendingSelection;
  const requiresRelaunch = snapshot.requiresRelaunch;

  return () => disposeConsumer();
});
```

The full snapshot is deeply frozen:

- `settings` is the merged `config.yaml` result.
- `harness` is the active launcher and synchronized composition state.
- `pendingSelection` is the latest unacknowledged transition target, when one exists.
- `requiresRelaunch` reports whether active state still differs from pending intent.

The provider publishes a new snapshot for a replacement session. Never mutate a snapshot, keep it
at module scope, or retain it after the injection is disposed. Consumers that register Pi callbacks
may close over an active Cordis context only when their injection cleanup clears that binding.

## Cross-axis transition state

Major-mode, domain, and profile packages own resolution and user interaction for their respective
axes. The transition coordinator serializes their requests against the current session,
configuration generation, and synchronized artifacts.

Config supplies two append-only Pi custom entry types:

- `doom-pi:config:v1` records a complete selected major mode, domains list, optional profile, and
  optional composition fingerprint.
- `doom-pi:transition:v1` records an operation ID, active selection, target selection, strategy, and
  `pending`, `applied`, `aborted`, or `superseded` phase.

Active selection and pending intent are different state. A reload-capable transition stages the
target harness and appends journal entries before calling Pi reload. A launcher-owned composition
change keeps pending intent for process relaunch. A fresh session acknowledges a pending record only
when both the exact target selection and composition fingerprint are active.

Pre-application failure must not claim the target as active. Do not bypass the coordinator, mutate
`snapshot.harness`, or treat environment transport as the durable journal.

## Verification

```sh
pnpm nx test @agimon-ai/doompi-config
pnpm nx typecheck @agimon-ai/doompi-config
pnpm nx build @agimon-ai/doompi-config
pnpm nx test @agimon-ai/doompi
pnpm --filter @agimon-ai/doompi exec doompi --explain
```

Run a parent-session smoke test when changing Cordis publication, provider replacement, reload, or
process-relaunch behavior.
