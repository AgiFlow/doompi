# Concepts

[Back to DoomPi](../README.md)

DoomPi separates two decisions that agent setups often mix together:

1. **Composition** decides which executable extensions form the session.
2. **Context selection** decides which subject matter and point of view are active within that composition.

```text
major mode -> extension layers -> executable session shape
minor modes ------------------> temporary behavior inside the session
domains ----------------------> skills, agents, hooks, and MCP access
profile ----------------------> persona text and environment defaults
```

This separation keeps the base predictable and lets temporary capabilities leave context when the job no longer needs them.

## Major modes define the base

A major mode names an ordered list of extension layers. Only one is active at a time. A development mode may include editing and delegation layers; a writing mode may choose a different package graph.

Changing a major mode first resolves the candidate composition. DoomPi then decides whether Pi can reload it or whether the launcher must start a replacement process. In a synchronized session, the candidate must already have a prepared runtime bundle. See [Composition and runtime bundling](bundling.md).

Major modes answer: **what kind of session is this?**

## Minor modes change temporary behavior

Minor modes are switches within the current base. They do not define the package graph. The owning packages are already in the composition, but their instructions, tools, or behavior stay inactive until selected.

DoomPi ships these minor modes:

- **Help:** expose package-owned guidance while it is needed.
- **Plan:** remove Pi's file-editing tools while an approach is agreed.
- **Loop:** run a prompt now and repeat it on a schedule.
- **Goal:** keep one objective active until it is completed or dismissed.
- **Workflow:** run jobs with dependencies, timeouts, and artifacts.
- **Voice:** use local capture and speech for a hands-free session.

Minor modes answer: **what should this session do for the next part of the work?**

## Domains scope subject-matter capabilities

A domain selects agent plugins for one kind of work. Plugins can contribute skills, agents, hooks, and MCP configuration. The plugin is cataloged once; domains refer to that catalog entry and may enable all or only part of it.

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

A root may be a Codex-compatible marketplace, one plugin, or a directory whose direct children are plugins. Discovery is deliberately nonrecursive. A deeply nested tool does not become executable by accident.

Home and repository catalogs merge, with repository entries replacing names from home configuration. Remote Git and npm plugins are cached under `~/.pi/.doom/plugin-cache`. Pin a Git SHA or exact npm version when reproducibility matters.

Use `--domains development,review`, an alias configured in `domains.yaml`, or `/domains` in a running session. `--no-domains` gives the session no domain plugin context.

Domains answer: **which knowledge and external systems belong to this job?**

## Profiles supply a point of view

A profile supplies persona files and string environment defaults. It can hold editorial rules, a company narrative, or a review posture. No profile is a valid selection.

```yaml
profiles:
  roots: [agents/acme]
  entries:
    editor:
      persona: agents/special/editor
      env:
        EDITOR_MODE: strict
```

A profile root may contain persona files itself or contain direct-child profile directories. DoomPi recognizes `profile.md`, `SOUL.md`, and `AGENTS.md` and concatenates them in that order. Discovery does not recurse.

Explicit entries override discovered profiles. Environment values already exported by the caller win over profile defaults. Select a profile with `--profile editor` or `/profile`.

Profiles answer: **from what perspective should the session work?**

## Why context is scoped

Every tool schema, skill name, and instruction consumes context and creates another action the model might choose. A smaller selection reduces the tokens spent before work starts and removes irrelevant choices. Workflow steps can select their own composition and domains instead of inheriting everything from the dispatching session.

This is not a security boundary. Removing a capability from model context is different from sandboxing a process or requiring approval. See [Trust and data boundaries](trust-and-data-boundaries.md).

## The interface follows the active composition

Press `SPC` on an empty draft to open the Leader map. It shows commands contributed by the packages active in the current composition. A space inside a nonempty prompt remains ordinary text.

Autonomous Voice mode applies only to its exact active TUI session. It can narrate openings, milestones, and final answers according to the configured capture, transcription, model, and speech engines.

See [Configuration](configuration.md) for definitions and merge behavior, and [Features](features.md) for the packages that implement these concepts.
