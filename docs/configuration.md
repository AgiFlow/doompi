# Configuration

[Back to DoomPi](../README.md)

DoomPi reads four configuration files:

- `config.yaml` defines runtime settings such as trust, editor, planning, and voice behavior.
- `modes.yaml` defines default packages, extension layers, and major modes.
- `domains.yaml` catalogs plugins and sets session access.
- `profiles.yaml` supplies persona files and environment defaults.

DoomPi reads personal defaults from `~/.pi/.doom/` and repository settings from `<repository>/.doom/`. Relative personal paths resolve from `~/.pi/.doom/`; relative repository paths resolve from the repository root. Merge behavior depends on the file and field, so the sections below state it explicitly.

## `config.yaml`: set runtime policy

`config.yaml` accepts only `projectTrust`, `modes.planning`, `editor`, `voice`, and `selection`. Unknown keys and invalid values stop configuration loading.

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

selection:
  majorMode: copilot
  domains: [development]
  profile: reviewer
```

`projectTrust` accepts `ask`, `always`, or `never`. It is repository policy: an absent repository value becomes `ask` instead of inheriting the personal value. `editor.command` is personal, so a repository editor value does not replace it. Planning fields and ordinary Voice fields merge, with repository values winning. `voice.autoCapture` is personal-only and is rejected in repository configuration.

Planning `thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. `plansDirectory` may be absolute, use `~`, or be relative to the repository. `selection` supplies default axis values; it does not define modes, domains, or profiles. When repository `selection` exists, include every personal axis that should remain selected because omitted axes are not inherited.

## `modes.yaml`: choose behavior

A layer is an ordered bundle of extension packages and hook groups. A major mode names the
layers that should run together. The top-level `default.packages` list is the ordered package
baseline for every major mode. `doompi init` and `dpi init` write the distribution's current
feature packages there so the baseline is visible and replaceable. If `default` is absent,
DoomPi adds no default feature packages. Use `default.packages: []` for an explicit empty
baseline. The fixed host core remains active independently of this setting, and named layers
keep their existing behavior.

Launch installs missing required packages from the defaults and selected layers. `doompi sync`
installs missing required packages from the defaults and every declared layer, then builds the
synchronized matrix. `doompi sync --check` reports missing packages without modifying the
repository. Optional packages and local paths are not installed automatically. Removing an
entry stops activating it but leaves Pi's package cache available for later reuse.

Packages in `default` and named layers may be bare strings, or mappings when the package accepts
configuration:

```yaml
default:
  packages:
    - '@agimon-ai/doompi-help'
    - '@agimon-ai/doompi-hook'
    - '@agimon-ai/doompi-goal'
    - '@agimon-ai/doompi-voice'
    - '@agimon-ai/doompi-runner'
    - '@agimon-ai/doompi-read'
    - '@agimon-ai/doompi-grep'
    - '@agimon-ai/doompi-edit'
    - '@agimon-ai/doompi-file-edit'
    - '@agimon-ai/doompi-autocompact'
    - '@agimon-ai/doompi-loop'
    - '@agimon-ai/doompi-plan'
    - '@agimon-ai/doompi-workflow'
    - '@agimon-ai/doompi-log'
    - '@agimon-ai/doompi-mcp'

layers:
  team:
    packages:
      - name: '@agimon-ai/doompi-team'
        config:
          models:
            - model: provider/model-id
              thinking: high
  review:
    packages:
      - '@scope/review-extension'

defaultMajorMode: copilot
majorMode:
  minimal:
    description: Lean sessions with delegation and little else.
    layers: [team]
  copilot:
    description: General coding with delegation and review tools.
    layers: [team, review]
```

Order matters. DoomPi activates `default.packages` first, then each selected layer from left to right. Put settings under the package that consumes them. Home and repository `layers` and `majorMode` records merge by name, with the repository definition replacing a collision. If both sources declare `default`, the repository block replaces the complete personal default. A repository entry set to `null` removes the matching layer or major mode.

Configurations created before the hashline tools were split may contain only `doompi-edit`.
Replace that entry with the ordered `doompi-read`, `doompi-grep`, and `doompi-edit` trio. Init
preserves existing configuration unless it is run with `--force`.

Choose a mode with `--major-mode copilot`, switch it with `/mode`, or change
`defaultMajorMode` when one mode should be the ordinary starting point.

## `domains.yaml`: choose content and access

Plugins are cataloged once, then domains refer to their names. A root can be a marketplace,
a single plugin, or a container whose direct-child folders are plugins. Discovery is
intentionally nonrecursive: a tool buried five directories down should not load by accident.

```yaml
defaultDomains: [development]

plugins:
  roots: [plugins]
  entries:
    remote-review:
      source: url
      url: '<REVIEW_PLUGIN_GIT_URL>'
      ref: v1.2.0
    published-research:
      source: npm
      package: '@acme/research-plugin'
      version: 1.4.0

domains:
  development:
    description: Repository implementation tools.
    plugins: [coding-tools]
  review:
    description: Focused review skills with a narrow MCP boundary.
    plugins:
      - name: remote-review
        skills: [typescript]
        agents: [reviewer]
        hooks: false
        mcp: true
    mcp:
      servers: [filesystem]
      proxy: [github]

aliases:
  work: [development, review]
```

Here, `coding-tools` is discovered from `plugins/coding-tools`; its manifest name, or its
folder name when no manifest name exists, becomes the catalog ID. Local roots and entries
resolve beside the declaring file. Git and npm entries are cached in
`~/.pi/.doom/plugin-cache`; pin a Git SHA or exact package version when reproducibility
matters. Domains may load an entire plugin or select only its skills, agents, hooks, and MCP
configuration. The optional `mcp` mapping is an allowlist, not a request to start every server
in the repository.

Select one or more domains with `--domains development,review`, use an alias such as
`--domains work`, or switch them with `/domains`. `--no-domains` is useful when the right
amount of repository context is none.

## `profiles.yaml`: choose a point of view

A profile directory becomes discoverable when it directly contains `profile.md`, `SOUL.md`,
or `AGENTS.md`. A root may be one profile or a container of direct-child profiles. The folder
name becomes the profile name; DoomPi concatenates those three files in that order.

```yaml
profiles:
  roots: [personas]
  entries:
    release-writer:
      persona: personas/release-writer
      env:
        BRAND: acme
        TONE: concise
```

With that config, `personas/release-writer/profile.md` is enough to discover
`release-writer`. The explicit entry is optional; use one when the profile needs another name,
an exact persona path, or string environment defaults. Explicit entries override discovered
folders. Already exported environment values win, so selecting a profile never quietly
replaces a value supplied by the caller.

Discovery never recurses. Persona paths must remain under `agents/` or a root declared in the
same file, and symlinks may not escape the persona boundary. Legacy profiles written directly
under `profiles` still load, but new configuration should use `roots` and `entries`.

Select a profile with `--profile release-writer` or switch it with `/profile`. Leaving the
catalog empty is valid; no profile remains a first-class choice.

## Check the matrix before launch

Resolve configuration before starting a model:

```bash
doompi --major-mode copilot --domains work --profile release-writer --explain
doompi --major-mode copilot --domains work --no-mcp --explain
dpi sync
doompi sync --check
```

`--explain` prints the resolved mode, domains, profile, plugins, skills, agents, MCP boundary, and estimated prompt cost. It may start configured stdio MCP servers to inspect their tool schemas; add `--no-mcp` to prevent that execution. `dpi sync` synchronizes repository state without persisting a Pi settings overlay. `doompi sync --check` reports drift with a non-zero exit code and does not modify the repository.
