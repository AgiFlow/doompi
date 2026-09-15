# `domains.yaml` authoring contract

## Files and precedence

DoomPi reads `~/.pi/.doom/domains.yaml` first and `<repo>/.doom/domains.yaml` second. The document accepts only these top-level keys:

- `plugins`: plugin discovery roots and explicit catalog entries.
- `domains`: named resource selections.
- `aliases`: names that expand to arrays of concrete domain names.
- `defaultDomains`: the selection used when no higher-precedence source names domains.

Relative paths in the personal file resolve from `~/.pi/.doom`. Relative paths in the repository file resolve from the repository root.

Plugin roots from both files accumulate in source order and exact duplicate roots are removed. Explicit plugin entries, domains, and aliases merge by name. A repository definition replaces the complete personal definition with the same name, rather than deep-merging it. A repository `defaultDomains` replaces the personal value when present; omitting it inherits the personal value. `defaultDomains: []` is an explicit empty default.

At selection time, a present `DOOMPI_DOMAINS` value outranks `defaultDomains`, including an explicitly empty environment value. When neither exists, the compatibility fallback is `marketing` for the marketing major mode and `default` otherwise. Command-line or persisted session selections are applied by their caller before this fallback is needed.

## Complete example

```yaml
defaultDomains: [work]

plugins:
  roots: [plugins]
  entries:
    repository-tools:
      source: local
      path: tools/repository-plugin
      description: Repository implementation tools.
    review-tools:
      source: url
      url: https://github.com/acme/review-tools.git
      path: plugins/review
      ref: v2
      sha: 0123456789abcdef0123456789abcdef01234567
    incident-tools:
      source: npm
      package: '@acme/incident-tools'
      version: 3.1.0

domains:
  development:
    description: Implementation and review resources.
    plugins:
      - repository-tools
      - name: review-tools
        skills: [typescript, review-*]
        agents: [reviewer]
        hooks: false
        mcp: true
    sharedSkills: true
    mcp:
      servers: [code-intel, agiflow-proxy]
      proxy: [repository-search]
  operations:
    description: Incident response resources.
    plugins: [incident-tools]
    mcp:
      servers: [agiflow-proxy]
      proxy: [production-observability]

aliases:
  work: [development, operations]
```

## Plugin discovery roots

`plugins.roots` is an array. Each path can identify:

- a supported marketplace root or its manifest;
- one plugin root; or
- a container whose direct-child directories are plugins.

Discovery does not recurse beyond direct children. Use another root or an explicit entry for a deeper plugin. DoomPi recognizes schema-gated Agent Plugins v1 `plugin.json` files and the legacy `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, and `.cursor-plugin/plugin.json` locations. A discovered plugin uses its manifest `name`, or its directory name when the manifest omits one.

DoomPi also inspects supported personal and repository marketplace locations automatically. Marketplace IDs are qualified as `plugin@marketplace`. When the same marketplace ID appears more than once, the first discovered marketplace entry wins. Explicit `plugins.entries` are applied last and may intentionally replace discovered IDs.

## Explicit plugin sources

Every `plugins.entries` key is the stable ID that domains reference.

Local plugins can use a path shorthand or the canonical mapping:

```yaml
plugins:
  entries:
    short-local: plugins/short-local
    local-tool:
      source: local
      path: plugins/local-tool
```

Git repositories use `source: url`. Use `source: git-subdir` when `path` is required by the declaration:

```yaml
plugins:
  entries:
    whole-repository:
      source: url
      url: acme/whole-plugin
      sha: 0123456789abcdef0123456789abcdef01234567
    monorepo-plugin:
      source: git-subdir
      url: ssh://git@example.com/acme/plugins.git
      path: packages/doom-plugin
      ref: main
      sha: fedcba9876543210fedcba9876543210fedcba98
```

Git URLs may be HTTP, HTTPS, SSH, `file:`, scp-like `git@host:path`, absolute paths, declaring-root-relative `./` paths, or `owner/repository` GitHub shorthand. A remote `path` must remain inside the checkout. `git-subdir` requires it. When `sha` is present, DoomPi checks out and verifies that commit; otherwise it uses `ref` when supplied.

npm plugins use a valid package name, plus optional version and registry:

```yaml
plugins:
  entries:
    published-tool:
      source: npm
      package: '@acme/published-tool'
      version: 1.4.2
      registry: https://registry.npmjs.org
```

Git and npm sources materialize under `~/.pi/.doom/plugin-cache`. Cache identity includes the complete source descriptor. An existing cache is reused and does not refresh a mutable branch, tag, npm range, or unversioned package automatically. Prefer a full Git `sha` or exact npm `version`. Change the descriptor to produce a new cache identity when updating deliberately.

## Domains and resource filters

A domain accepts only `description`, `plugins`, `mcp`, and `sharedSkills`.

A string in `plugins` selects every supported resource from that catalog entry. The mapping form selects the same plugin with optional controls:

- `skills`: skill frontmatter names to retain. Exact names and `*` wildcards are supported.
- `agents`: agent frontmatter names to retain. Exact names and `*` wildcards are supported.
- `hooks`: set `false` to omit the plugin's `hooks/hooks.json`; omission keeps it.
- `mcp`: set `false` to omit the plugin's MCP source; omission keeps it.

`sharedSkills: false` opts out of repository `.claude/skills`. Shared skills remain enabled unless every selected concrete domain sets it to `false`.

The domain-level `mcp.servers` list keeps named servers from the merged repository and plugin MCP configuration. `mcp.proxy` keeps named upstreams from the `agiflow-proxy` configuration. Allowlist values from selected domains are unioned, but filtering activates only when every selected concrete domain declares `mcp`. If any selected domain omits `mcp`, the selection remains unfiltered. An omitted or empty `servers` or `proxy` list also leaves that slice unfiltered; an empty array is not a deny-all policy.

Aliases expand once to their listed concrete domain names. Keep alias targets concrete rather than chaining aliases. Domain and alias names both appear in `/domains` discovery. Plugin directories are deduplicated by resolved directory in first-selection order.

## Verification

From the repository root:

```sh
doompi --domains development --explain
doompi --domains development,operations --explain
doompi sync --check
```

Confirm the explanation lists the expected domains, plugin names, skill paths, agents, MCP servers, and proxy upstreams. Start a session and use `/domains` or `list_domains` to confirm the active and available names. A live switch uses `/domains <name[,name...]>` and reloads the session after validation and resource staging.

Run mutating `doompi sync` only when the user intends to materialize remote sources or refresh
synchronized runtime artifacts.

For source changes in this repository, run:

```sh
pnpm nx lint @agimon-ai/doompi-domain
pnpm nx typecheck @agimon-ai/doompi-domain
pnpm nx build @agimon-ai/doompi-domain
pnpm nx test @agimon-ai/doompi-domain
```
