# Concepts

[Back to DoomPi](../README.md)

## Philosophy

An agent does not need every tool for every job. DoomPi separates the base session from
the things you switch on for a while: modes choose behavior, domains choose subject
matter, and profiles choose a point of view.

### Major and minor modes

A major mode is the base config. It names the extension layers for development, marketing,
or whatever else you do. Define as many as you like; only one is active at a time, and you
can switch it without leaving the session.

Minor modes are batteries-included switches inside that base. They start off, stack freely,
and keep their model tools and skills out of context until turned on. DoomPi ships six:

- **Help mode:** expose package-owned guidance only while you need it.
- **Plan mode:** remove Pi's file-editing tools while you agree on an approach.
- **Loop mode:** run a prompt now, then run it again on a schedule.
- **Goal mode:** keep one objective in view until it is done or dismissed.
- **Workflow mode:** run jobs with dependencies, timeouts, and artifacts.
- **Voice mode:** replace typing with local speech.

### Domains

A domain is a named group of agent plugins. It carries the skills and MCP servers for one
kind of work, and `/domains` switches it while the session is running.

Plugins are cataloged once and domains refer to their names. A configured root may be a
Codex-compatible marketplace or a folder whose direct children are plugins, so a repository
with many plugins does not need one entry per directory:

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

DoomPi also checks personal and repository Codex marketplace layouts. Marketplace IDs use
`plugin@marketplace`. Remote Git and npm sources are downloaded once into the persistent
`~/.pi/.doom/plugin-cache` directory. Cache entries are reused until their source descriptor
changes; use a Git SHA or exact npm version for reproducible installs. Home and repository
catalogs merge, and repository names replace matching home names.

A blog is not one task. Research it, draft it, make the assets, then review it. Turn on the
`visual` domain while making assets; the other three steps have no reason to carry it.

### Profile

An LLM has no house style until you give it one. A profile can supply a narrative, brand
rules, or a different voice. It is optional; no profile is a perfectly good profile.

Profile roots remove the need to list every persona folder. A root may itself contain the
persona files, or its direct-child folders become profiles named after those folders. DoomPi
recognizes `profile.md`, `SOUL.md`, and `AGENTS.md` and never searches deeper directories.

```yaml
profiles:
  roots: [agents/acme]
  entries:
    editor:
      persona: agents/special/editor
      env:
        EDITOR_MODE: strict
```

Roots from the home and repository files accumulate relative to their declaring config.
Repository discoveries replace same-named home discoveries. Explicit entries override
discovery and can add string environment defaults; repository entries replace matching home
entries. Select one at launch with `--profile editor` or switch with `/profile`.

## What this buys you

Every tool schema and skill name competes for the same context. Loading less has two
immediate effects:

1. You spend fewer tokens before the work begins.
2. The model has fewer plausible-but-wrong tools and skills to choose from.

The savings get larger when each workflow job starts with its own config instead of
inheriting the last job's toolbox.

### Copilot

I got tired of remembering slash commands, so `SPC` is the map. It opens only when the
draft is empty; a space in the middle of a prompt remains a space. Press it, read the
choices, then press the next key.

When the keyboard is the wrong tool, autonomous Voice mode keeps the conversation going.
You can talk to the agent while doing the chores instead of carrying a laptop around the
house, and the primary agent can speak its own opening, milestone, and final updates.
