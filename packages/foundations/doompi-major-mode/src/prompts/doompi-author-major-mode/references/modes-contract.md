# DoomPi `modes.yaml` authoring contract

## Purpose and sources

`modes.yaml` controls the behavior axis of a DoomPi session:

- `default.packages` is the unconditional package baseline.
- `layers` are reusable ordered bundles of extensions, packages, and hook groups.
- `majorMode` maps a session mode to an ordered list of layer names.
- `defaultMajorMode` selects the starting mode when no flag or inherited environment value wins.

DoomPi reads `~/.pi/.doom/modes.yaml` first and `<repoRoot>/.doom/modes.yaml` second. Either file may
stand alone. A missing or empty file contributes nothing.

Named `layers` and `majorMode` entries merge by name. A repository entry replaces the complete
personal entry with the same name. Setting an inherited layer or mode to `null` removes it. The
top-level `default` block is also replaced as a whole when the repository declares it. An omitted
repository `default` keeps the personal definition. `defaultMajorMode` uses the last declared value.

Relative paths retain the source that declared them:

- Personal paths resolve from `~/.pi/.doom`.
- Repository paths resolve from the repository root, not from `<repoRoot>/.doom`.

## Supported shape

```yaml
# Optional package baseline loaded before every selected named layer.
default:
  packages:
    - '@agimon-ai/doompi-help'
    - name: '@scope/optional-extension'
      optional: true
      config:
        policy: concise

layers:
  local-review:
    extensions:
      - './extensions/review.ts'
    packages:
      - '@scope/review-extension'
    hookGroups: [repository]
  team:
    packages:
      - name: '@agimon-ai/doompi-team'
        config:
          models:
            - model: provider/model-id
              thinking: high

defaultMajorMode: copilot
majorMode:
  minimal:
    description: Small sessions with delegation only.
    layers: [team]
  copilot:
    description: General coding with delegation and local review policy.
    layers: [team, local-review]
```

Treat the `default` example as a shape, not as the current distribution package list. Preserve the
baseline emitted by `doompi init` unless the user explicitly wants to replace it. If neither source
declares `default`, DoomPi adds no fallback feature package set. `default.packages: []` deliberately
selects an empty baseline. Fixed core packages remain active independently.

### `default`

`default` accepts exactly one field, `packages`, and `packages` must be an array. It does not accept
`extensions` or `hookGroups`. Its packages activate before packages from selected named layers.

### `layers`

Each layer is a mapping with these supported fields:

- `extensions`: an array of non-empty strings. A bare name selects a DoomPi built-in extension.
  A `./` or `../` path, or an absolute path, selects a Pi-compatible script or extension directory.
- `packages`: an array of package strings or package mappings. A normal npm package activates its
  ordered `package.json` `pi.extensions` entries. An exported subpath can select one adapter.
  Path-like packages are supported for local unpublished Pi packages.
- `hookGroups`: an array of hook group IDs contributed by the layer. Duplicate group IDs are
  removed while retaining first-seen order.

A package mapping accepts only:

- `name`: required non-empty package specifier or local path.
- `optional`: optional boolean. A missing optional package is skipped and is not installed.
- `config`: optional mapping owned and interpreted by that package. Its contents stay opaque to the
  major-mode parser.

Required npm packages missing from the active baseline or selected layers can be installed during
launch. `doompi sync` considers required packages from the baseline and every declared layer.
Optional packages and local paths are not installed automatically.

Package configuration belongs inside its package mapping. Layer-level `config` is rejected because
there is no unambiguous owner. The removed `targets` field is also rejected. Select a layer by naming
it from the appropriate major modes.

When hooks are disabled for a run, any selected layer with one or more `hookGroups` is suppressed as
a whole. Its extension and package entries are suppressed too. Keep unrelated packages out of a
hook-only layer if they must remain active when hooks are off.

### `majorMode` and `defaultMajorMode`

New major modes use this mapping form:

```yaml
majorMode:
  review:
    description: Focused review with repository policy and Team delegation.
    layers: [team, local-review]
```

`description` must be a non-empty string and `layers` must be an array of non-empty layer names.
Every referenced layer must survive source merging. Layer order and repeated entries are preserved.
The array-only compatibility form, such as `review: [team, local-review]`, is accepted and receives a
generated description, but new configuration should use the mapping form.

When `defaultMajorMode` is explicitly configured, it must name a surviving mode. If no source
declares it, DoomPi uses the compatible `copilot` fallback. Declare an explicit default when the
available modes do not include `copilot`.

## Safe changes

- Add a package to an existing layer when it should follow that layer's activation and ownership.
- Add a new layer when the behavior should be reusable across multiple modes or independently
  ordered.
- Add a new mode by composing existing layers, then add new layers only for missing behavior.
- Use a repository replacement when a shared personal definition is unsuitable for one repository.
- Use `null` only to remove an inherited named layer or named mode. Do not use it as a package entry
  or as a partial-field deletion mechanism.
- Keep local paths within trusted, reviewable locations and confirm they resolve from the declaring
  source's base directory.

## Verification

Run a read-only resolution before launching:

```sh
doompi --major-mode review --explain
```

Confirm the reported major mode, ordered layers, hook groups, and resulting resources. If packages
or synchronized composition changed, check drift and missing packages without updating artifacts:

```sh
doompi sync --check
```

Run `doompi sync` only when the user intends to install packages or refresh synchronized artifacts.
For repository changes to the parser or templates themselves, run the affected Doom Config and
DoomPi lint, typecheck, build, and test targets.
