# Concepts

[Back to DoomPi](../README.md)

An agent does not need the same setup for every job. DoomPi lets you choose the
packages that run, then narrow the tools, skills, and instructions used for the work
at hand.

Those are two separate decisions:

1. **Composition:** which executable extensions form the session.
2. **Context selection:** which subject matter and point of view are active within it.

```text
major mode -> extension layers -> executable session shape
minor modes ------------------> temporary behavior inside the session
domains ----------------------> skills, agents, hooks, and MCP access
profile ----------------------> persona text and environment defaults
```

Keep the base useful. Switch on the rest when the job calls for it.

## Major modes define the base

A major mode is the preset. It names an ordered list of extension layers, and only
one major mode is active at a time. A development mode might include editing and
delegation; a writing mode might choose a different set of packages.

Changing the preset can change the code that runs. In the terminal, DoomPi resolves
the new composition before deciding whether Pi can reload it or the launcher needs
to start a replacement process. A synchronized session needs a prepared bundle for
that composition. The headless host instead switches contributions from the server
facets admitted for its synchronized generation. See [Composition and runtime
bundling](bundling.md) and [Architecture](architecture.md#selection-and-transitions).

## Minor modes change temporary behavior

Minor modes are switches you can turn on and off during a session. Their packages
must already be in the composition, but their mode-specific instructions, tools,
or behavior stay inactive until selected. You can use more than one at a time.

DoomPi ships these minor modes:

- **Help:** bring package-owned guidance into context while you need it.
- **Plan:** work with a reduced tool set and save a dedicated plan for review.
- **Loop:** run a prompt now and repeat it on a schedule.
- **Goal:** keep one objective active until it is completed or dismissed.
- **Workflow:** run jobs with dependencies, timeouts, and artifacts.
- **Voice:** keep the conversation going without the keyboard.
- **Author:** annotate and work on documents in the cockpit.
- **Computer use:** let the agent use the computer through DoomPi Desktop.

See [Features](features.md) for each mode's controls and limits. A mode is not a
sandbox: Plan still allows inspection through Bash and configured MCP tools, with
instructions to keep that work read-only.

## Domains scope subject-matter capabilities

Modes choose Pi or DoomPi extensions. Domains choose agent plugins, including Codex
and Claude Code plugins. A plugin can carry skills, agents, hooks, and MCP
configuration for one kind of work. Catalog it once, then let each domain select
all or part of it.

```yaml
plugins:
  roots: [plugins]
  entries:
    remote-review:
      source: url
      url: '<REVIEW_PLUGIN_GIT_URL>'
      ref: v1.2.0

domains:
  development:
    description: Implementation and code-review tools.
    plugins: [pi-development, remote-review]
```

A plugin root can be a Codex-compatible marketplace, a single plugin, or a directory
whose direct children are plugins. Discovery does not recurse through arbitrary
nested directories.

Home and repository catalogs merge by name, with repository entries winning.
Remote Git and npm plugins are cached under `~/.pi/.doom/plugin-cache`. Pin a Git
SHA or an exact npm version when the same configuration needs to load the same code.

Choose domains with `--domains development,review`, an alias in `domains.yaml`, or
`/domains` during a session. Use `--no-domains` to leave domain plugin context out.

Domains answer: **which knowledge and external systems belong to this job?**

## Profiles supply a point of view

A profile supplies a point of view: editorial rules, a company narrative, or a
review posture. It consists of persona files and string environment defaults.
It is optional. No profile is a perfectly good profile.

```yaml
profiles:
  roots: [agents/acme]
  entries:
    editor:
      persona: agents/special/editor
      env:
        EDITOR_MODE: strict
```

A profile root can contain persona files itself or direct-child profile
directories. DoomPi reads `profile.md`, `SOUL.md`, and `AGENTS.md` in that order and
joins their contents. It does not recurse into deeper directories.

Explicit entries override discovered profiles. Environment values you already
exported win over profile defaults. Choose a profile with `--profile editor` or
`/profile`.

Profiles answer: **from what perspective should the session work?**

## Why context is scoped

Every tool schema, skill name, and instruction takes up context and gives the model
another possible choice. A smaller selection spends fewer tokens before work
starts and leaves out irrelevant tools. Workflow jobs can choose their own
composition and domains rather than inherit the dispatching session's whole toolbox.

This is not a security boundary. Leaving a tool out of context is different from
sandboxing a process or requiring approval for an action. See [Trust and data
boundaries](trust-and-data-boundaries.md).

## The interface follows the active composition

In the terminal, press `SPC` on an empty draft to open the Leader map. It shows
commands from the packages active in your composition. A space inside a nonempty
prompt is still just a space.

Voice can narrate openings, milestones, and final answers using the configured
capture, transcription, model, and speech engines. See [Features](features.md) for
host-specific behavior.

See [Configuration](configuration.md) for the merge rules and complete examples,
and [Features](features.md) for the packages behind these concepts.
