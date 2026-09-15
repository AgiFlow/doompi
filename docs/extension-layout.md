# Extension layout

[Back to DoomPi](../README.md)

A folder-based convention for authoring extensions: the path declares the contribution, so a package carries no parallel registry of what it contains. This is the authoring surface for the mounts described in [Extension lifecycles](lifecycles.md).

`@agimon-ai/doompi-build` reads this layout and generates each host entry. Legacy catch-all entries and implementation roots are rejected rather than treated as transitional input.

## Borrow, do not invent

The convention is optimised for people and coding agents who already know mainstream full-stack frameworks. Every mechanism is lifted from one of them, unchanged. Where DoomPi has no analogue, the closest widely-known precedent wins.

| Mechanism                                   | Borrowed from                                       |
| ------------------------------------------- | --------------------------------------------------- |
| `(group)` folders, invisible to the path    | Next.js App Router route groups                     |
| `_folder`, excluded from routing            | Next.js private folders                             |
| `[param]`, `[...slug]` dynamic segments     | Next.js                                             |
| `route.ts` as an HTTP route leaf            | Next.js Route Handlers                              |
| A directory per kind, filename is identity  | Nuxt (`server/api/`, `components/`, `composables/`) |
| `.web.tsx` and `.ios.tsx` platform suffixes | Expo and Metro                                      |

Next.js has no analogue for plugin contributions that are not routes, so tools, tabs and fills follow Nuxt's directory-per-kind model. Everything with a URL follows Next.js exactly.

## The shape

Four axes, each read off the path.

```text
src/extensions/<scope>/(side)/<surface>/<name>[.<target>][.<platform>].<ext>
       axis 1     axis 1  axis 2   axis 3          axis 4
```

The routing root defaults to `src/extensions`, which is already a canonical source root. `src/extension` is accepted as an alias.

## Prefixes

| Prefix     | Meaning                                                 | Contents scanned |
| ---------- | ------------------------------------------------------- | ---------------- |
| `(name)/`  | Group. Organisational only, invisible to the path.      | yes              |
| `_name/`   | Private. Colocation. Never a contribution, never built. | no               |
| `[param]/` | Dynamic segment. Only inside `api/`.                    | yes              |

`(backend)` and `(frontend)` are reserved group names, reserved because they also select the build side. A package may add its own, such as `(admin)`, at no cost in the output.

Colocation needs no file-level marker, because each half of the tree already excludes non-contributions:

```text
(backend)/api/current/route.ts            a route
(backend)/api/current/validate.ts         colocated. only route.ts is a route
(frontend)/tab/PlanPanel.tsx              a tab
(frontend)/tab/_components/PlanRow.tsx    colocated. _folder is never scanned
```

`*.test.*`, `*.spec.*` and `*.stories.*` are excluded everywhere. A folder at a scannable level that is neither a known surface, a group, nor private produces a notice rather than silence, because a typo that silently contributes nothing is expensive to find.

## Axis 1: scope is folder nesting

```text
src/extensions/                       global      /api/plugins/<id>/...
src/extensions/workspaces/            workspace   /api/workspaces/{w}/plugins/<id>/...
src/extensions/workspaces/sessions/   session     /api/workspaces/{w}/sessions/{s}/plugins/<id>/...
```

These paths name the owner of a feature. Put machine-wide settings and plugin settings directly under `extensions/`, repository settings under `workspaces/`, and Pi commands, tools, hooks, and TUI views for the active agent under `workspaces/sessions/`. The host supplies `workspaceId` and `sessionId`; a routed file does not encode either id.

The hosts use those paths differently. Pi has one extension mount per process, so the generator gathers its routed files into one Pi declaration; the session path describes ownership, not an additional Pi mount. The server has independent global, workspace, and session facets. Its generator repeats broader declarations into narrower facets, while a session file stays in the session facet. The browser merges broader contributions into narrower scopes when it mounts the cockpit. See [Extension lifecycles](lifecycles.md) for the runtime semantics.

## Axis 2: side is `(backend)` or `(frontend)`

Neither appears in any URL. The split is not cosmetic; it is a boundary three mechanisms already need and currently approximate with a hardcoded path.

| Concern         | Without the split                                                                                       | With it                         |
| --------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- |
| tsconfig        | root excludes `src/web` and the literal `src/extensions/web.ts`, browser config re-includes three paths | one glob each way               |
| Import boundary | the browser allowlist is pinned to one literal file path                                                | the rule matches the whole side |
| Published files | `files` lists web source paths by hand, because web ships as source and backend as dist                 | derived                         |

The sides separate logic from presentation; they do not name a host or an owner. A `.cli.ts` frontend file can render the Pi terminal, while a `.web.tsx` frontend file can render the browser. Browser code does not import backend code. A session CLI command may import a session frontend `overlay/*.cli.ts` route to open its TUI view or a private helper beside it. The session Pi root may import a private overlay helper to mount terminal status. Other cross-side imports are rejected by lint. Shared data contracts live in `src/types`, `src/constants`, `src/schemas`, or the generated API contract.

The split also narrows the suffix namespace, so the common case needs no suffix at all. Inside `(backend)`, no suffix means CLI and server. Inside `(frontend)`, no suffix means every frontend.

```text
(backend)/tool/write-plan.ts           CLI and server
(backend)/tool/write-plan.cli.ts       CLI only
(backend)/tool/write-plan.server.ts    server only
(frontend)/tool/write-plan.tsx         that tool's renderer, every frontend
(frontend)/tool/write-plan.ios.tsx     iOS override
```

Matching filenames across the two sides are the join. `(backend)/channel/tasks.ts` and `(frontend)/channel/tasks.ts` are one frame type. `(backend)/tool/write-plan.ts` and `(frontend)/tool/write-plan.tsx` are one tool and its renderer.

## Axis 3: surface is the folder

A directory per kind, filename is identity.

| Surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `(backend)` produces                   | `(frontend)` produces                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| `tool/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `tools` on CLI and server              | `toolRenderers`                          |
| `tool-restriction/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | tool restrictions                      | not scanned                              |
| `command/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `commands` on CLI and server           | `paletteCommands`                        |
| `shortcut/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | CLI shortcuts                          | not scanned                              |
| `hook/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | CLI `events`, server `hooks`           | not scanned                              |
| `mode/<id>/mode.*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `minorModes`                           | `minorModes`                             |
| `provider/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | CLI providers                          | not scanned                              |
| `api/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `api`, as a routed HTTP tree           | generated typed client                   |
| `channel/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `channels`, filename is the frame type | `channels`                               |
| `method/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `methods`, filename is the member      | typed caller                             |
| `resource/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | CLI and server resources               | not scanned                              |
| `tab/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | not scanned                            | `tabs`                                   |
| `dock/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | not scanned                            | `dockFaces`                              |
| `setting/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | not scanned                            | settings sections or panels              |
| `slot/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | not scanned                            | `slots`, named `<pluginId>.<file>`       |
| `fill/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | not scanned                            | any host region or plugin slot           |
| `action/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | not scanned                            | context and user message actions         |
| `store/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | not scanned                            | a store at the folder's scope            |
| `overlay/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | not scanned                            | CLI TUI view opened on demand            |
| `activity-group/`, `leader/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | not scanned                            | cockpit contributions                    |
| `selection-axis/`, `lifecycle/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | not scanned                            | singleton or named cockpit contributions |
| The backend scope root owns service injection and startup work. It returns its Cordis `services` and, on the server session, any host `activities`, alongside shared state and cleanup hooks. An activity can bind a session intercom or report suspended runs; it is unrelated to the browser's `activity` slot or `activity-group/` surface. A frontend `overlay/*.cli.ts` file owns the interactive view that a session command opens through Pi's `ui.custom`; Pi has no overlay registration array. |

### Gates are container folders

A gate folder wraps the surfaces it gates.

```text
(backend)/tool/write-plan.ts                 always available
(backend)/mode/plan/tool/write-plan.ts       only while minor mode `plan` is active
(backend)/mode/plan/mode.ts                  the mode declaration
(backend)/domain/billing/tool/invoice.ts     only inside domain `billing`
```

One gate, two host mechanisms, and hiding that is the point. The server gates through the tool's `when` field, which the headless kernel reads. The CLI has no `when`: the Pi adapter drops it, so the same gate has to become a tool restriction registered into the tool-surface service. An author should not have to know which host uses which.

## Axis 4: target is the filename grammar

```text
{name}[.{target}][.{platform}].{ext}
```

`{name}` is the first segment and is the contribution's identity. `{target}` appears only where the surface is relationship-bearing. `{platform}` is a closed set scoped to the side. Parsing runs right to left, so a dotted slot name stays unambiguous.

```text
fill/PlanRef.task.detail.tsx          fills plugin slot `task.detail`
fill/PlanSummary.activity.tsx         fills the host activity region
fill/PlanSection.activity.plan.tsx    fills activity group `plan`
slot/actions.ts                       declares slot `<thisPluginId>.actions`
hook/session-start.ts                 CLI `events.session_start`, server hook `session_start`
tool/write-plan.ts                    tool `write_plan`
```

Most specific wins, and a platform file replaces the neutral one for that platform.

**Filename is identity.** `(backend)/tool/write-plan.ts` declares tool `write_plan` and `(frontend)/tool/write-plan.tsx` renders it. This removes the cross-target strings an author matches by hand today: tool names, channel frame types, and status keys. A declaration may still pass an explicit name to keep a legacy identifier.

### One `fill/` folder, one rule

Every fill names a slot, and there is no host-region special case. The cockpit declares its own regions as real slots (`overlay`, `rail`, `context`, `selection-bar`, `activity`, `composer-actions`, `composer-menu`), and an activity group opens `activity.<group>`. So filling a host region and filling another plugin's slot are the same operation, spelled the same way.

```text
fill/PlanRail.rail.tsx                 -> { slot: 'rail', id: 'plan-rail' }
fill/PlanSection.activity.plan.tsx     -> { slot: 'activity.plan', id: 'plan-section' }
fill/PlanRef.task.detail.tsx           -> { slot: 'task.detail', id: 'plan-ref' }
```

This is why the build tooling knows none of those names. A layout package can declare new regions and extensions fill them without anything in the toolchain changing, and a fill naming a slot nobody declares stays what it already is: an install diagnostic, not a failure.

The older cockpit arrays (`overlays`, `railSections`, `contextSections`, `selectionBarItems`, `composerActions`, `composerMenuItems`, `activitySections`) remain as sugar over the same registry. Generated entries do not use them.

## A worked tree

```text
src/extensions/                                  GLOBAL
  (backend)/api/providers/route.ts               /api/plugins/<id>/providers
  (backend)/channel/presence.ts                  hub-lifecycle channel
  (frontend)/setting/account.tsx                 global settings page
  (frontend)/fill/AccountBadge.top-bar.tsx       global UI region
  (frontend)/store/account.ts                    defineGlobalStore

  workspaces/                                    WORKSPACE
    (backend)/api/repos/route.ts                 /api/workspaces/{w}/plugins/<id>/repos
    (frontend)/setting/plan.tsx                  workspace settings page
    (frontend)/store/repos.ts                    defineWorkspaceStore

    sessions/                                    SESSION
      (backend)/api/current/route.ts
      (backend)/tool/write-plan.ts
      (backend)/channel/tasks.ts
      (frontend)/tab/PlanPanel.tsx
      (frontend)/tool/write-plan.tsx
      (frontend)/channel/tasks.ts
      (frontend)/store/tasks.ts                  defineSessionStore

```

## Transports

Three, not four. SSE is not its own mechanism.

**HTTP, and SSE with it.** A backend `api/` tree follows the familiar folder path and `route.ts` leaf convention. The leaf default-exports one `defineRoute(...)` declaration. Request parsing, handlers, lifecycle, and public symbols belong in `src/services`, shared contracts, or a private colocated module.

```text
(backend)/api/current/route.ts
(backend)/api/runners/[runId]/log/route.ts
(backend)/api/runners/[runId]/log/stream/route.ts
```

An event stream is the same route returning `text/event-stream`, declared in the contract with an events schema map.

**WebSocket.** No extension opens a socket. The host owns the workspace and session sockets, and extensions put frames on them as channels: a hub channel on the backend, a session channel contribution on the frontend. The channel lifecycle comes from the scope folder rather than a field.

**Typed RPC.** `(backend)/method/<member>.ts` becomes a server method, with the service defaulting to the plugin id.

All three already live in one API contract document, where the HTTP list covers HTTP and SSE and the socket list covers channels and methods. The generator emits that contract from the tree, and `(frontend)` consumes the generated client instead of hand-writing fetches.

## Shared state

| Scope     | Helper                           |
| --------- | -------------------------------- |
| global    | `defineGlobalStore<T>(initial)`  |
| workspace | `defineWorkspaceStore<T>(empty)` |
| session   | `defineSessionStore<T>(empty)`   |

A session store binds a channel directly: given a channel name, a parse gate and a reducer, it returns a contribution with apply and drop already wired.

```text
(backend)/channel/tasks.ts    the hub channel, publishing through the direct event bus
        |
        v                     the hub pushes the frame down the workspace or session socket
(frontend)/channel/tasks.ts   the store's channel binding
        |
        v
(frontend)/store/tasks.ts     defineSessionStore, read with useStore
```

Inside one process, a route hands data to a channel over the direct event bus with no socket round trip. Across extensions, state is shared through Cordis services and nowhere else: one publishes, another injects by name. That is what keeps composition working, because no extension imports another and any of them may be absent at the next sync.

## How context reaches a routed file

A parameter, never ambient. Both existing helpers already take a factory, and the repository lints against ambient host access.

Every routed file exports a declaration or a factory of one, and the factory receives a mount context narrowed by its folder position.

| Position                                | Adds                                     |
| --------------------------------------- | ---------------------------------------- |
| `src/extensions/**`                     | `scope`, `signal`, the Cordis context    |
| `src/extensions/workspaces/**`          | `workspaceId`, `workspaceRoot`           |
| `src/extensions/workspaces/sessions/**` | `sessionId`, `cwd`, `agent`              |
| `(backend)/*.cli.ts`                    | the Pi extension API and runtime         |
| `(backend)/*.server.ts`                 | the server host service                  |
| `(frontend)/*.web.tsx`                  | the web plugin runtime, no Cordis        |
| `(frontend)/overlay/*.cli.ts`           | Pi's TUI context when a command opens it |

None of these fields are new. The convention narrows an existing union by path instead of handing every file the same wide bag.

**Mount context and invocation context are different.** The factory parameter resolves once when the mount starts. Per call, a handler additionally receives its own: a tool execution context for a tool, the request context for a route.

**Services stay context-free.** Modules under `src/services/**` take dependencies as parameters and know nothing about mounts. The routed file is the composition root that reads the mount context and constructs them.

## No catch-all entries

`extra.cli.ts`, `extra.server.ts`, and `extra.web.ts` are forbidden. They hide identity, cardinality, scope, and host ownership from both the scanner and reviewers. Use a standard named surface for every contribution. Shared mount state and lifecycle belong in `root.cli.ts` or `root.server.ts`.

A tool override stays in `tool/`, because from the author's side both values mean that the package provides the named tool:

```text
(backend)/tool/grep.cli.ts       definePiTool(tool, { overrides: true })
(backend)/tool/grep.server.ts    defineServerTool(tool)
```

The generated CLI entry splits additions and override claims at runtime.

## The export is typed, not free form

Every scanned file directly default-exports exactly one typed `define*` declaration. It has no named exports and no freeform implementation. Public symbols and shared logic belong in `src/exports`, `src/services`, shared contract roots, or a private `_lib` or `_components` directory.

```ts
// (backend)/tool/write-plan.ts
import { defineTool } from '@agimon-ai/doompi-core/extension-file';

export default defineTool((context) => ({
  description: 'Write the plan',
  parameters: WritePlanSchema,
  async execute(input, execution) {
    /* delegate to a service */
  },
}));
```

Backend helpers come from `@agimon-ai/doompi-core/extension-file`, frontend helpers from `@agimon-ai/doompi-core/web`. Derived identity keys remain optional in helper input types because an explicit legacy identity is allowed to win. Backend helpers accept a declaration or a mount-context factory. Frontend declarations remain data because the cockpit starts them separately.

Portable and native tools use different helpers. `defineTool` marks a portable declaration for host adaptation. `defineServerTool` and `defineCliTool` preserve native host contracts.

### Cardinality

A standard route contributes one value unless it explicitly says otherwise. Cardinality is helper metadata, never a pseudo-surface folder:

```ts
export default defineRoutedContribution(defineProvider(discoverProviders), { cardinality: 'many' });
export default defineRoutedContribution(optionalHook, { cardinality: 'optional' });
export default defineRoutedContribution(liveTools, { cardinality: 'collection' });
```

`optional` means zero or one, `many` means zero to many, and `collection` preserves a live collection contract such as `PiToolCollection`. Do not create `hook-optional/`, `resource-catalog/`, `tool-collection/`, or equivalent renamed aggregates. Resolve asynchronous discovery in an awaited root, then expose synchronous root-owned values to routes.

Root-owned services are Cordis plugins. The generator reads them before it builds deferred tools, commands, and other registrations.

## The generated entries live outside src

`src` is authored code. The build writes the three host entries to `generated/` at the package root instead, and the package gitignores that directory.

```text
generated/pi.ts       built to dist/extensions/pi.mjs, named by pi.extensions
generated/server.ts   built to dist/extensions/server.mjs, named by doompiServer
generated/web.ts      shipped as source, named by doompiWeb.client
```

Three things follow. They never appear in a review, because nothing tracks them. They are never hand-edited, because the next build overwrites them. And the formatter already skips a directory by that name, so generated output cannot drift from the formatter and dirty the tree on every build.

They still have to reach a consumer. `files` lists `generated/web.ts`, which is the one entry that ships as source for the cockpit to compile, and every Nx target that reads any of them depends on `^build`.

One consequence worth knowing: the cockpit points Tailwind at a plugin's `src/web` when it exists, and the generated entry's own directory otherwise. For a routed package that directory holds no components, so the class scanner falls back to the routing root instead.

## Colocation

A `_folder` is never scanned, at any depth, so implementation can sit next to the contribution that uses it. Prefer that over a distant shared root whenever exactly one surface uses the code.

```text
(backend)/tool/write-plan.ts          the contribution
(backend)/tool/_lib/parse.ts          used only by it
(backend)/_services/telemetry.ts      shared across this side, still not a contribution
(frontend)/tab/PlanPanel.tsx          the contribution
(frontend)/tab/_components/PlanRow.tsx  used only by it
_shared/format.ts                     shared across both sides
```

Inside `api/`, colocation needs no underscore at all: only `route.ts` is a route, so `api/plan/validate.ts` is already private.

Terminal presentation follows the same rule: `overlay/fleet.cli.ts` owns the TUI view, `overlay/_lib/fleetTranscript.ts` belongs beside it, `message/subagent-notify.cli.ts` owns its message renderer, and `tool/subagent.cli.ts` supplies the Pi tool's renderers. These files stay at the session frontend scope instead of a separate `src/tui` root.

Private helpers in `_lib` or `_internal` remain beside the routed file that uses them. Service injection and lifecycle cleanup belong in the scope root.

The rule of thumb: shared across surfaces goes to the implementation roots below, used by one surface goes in a `_folder` beside it.

## What does not move

- `src/prompts/<skill>/SKILL.md` stays. It is already a folder convention and a published path named by `llms.txt`. The generator derives the resource contributions from it.
- `src/services` holds platform-agnostic behavior. `src/schemas`, `src/types`, and `src/constants` hold shared contracts, while `src/web` holds browser presentation. Host registration and host-specific handlers live in routed files. A colocated `_folder` holds code shared by several files in one surface.

## Toolchain constraints

Parenthesised directory names are safe across oxlint, oxfmt, TypeScript `include` and `exclude`, the boundary matcher, Vite and rolldown, `npm pack` and `pnpm pack`, and Vitest. Two rules keep them that way.

1. **Never spell a paren directory in a picomatch pattern.** tsdown's globber treats a bare `(...)` as an extglob group, so a pattern naming the directory matches nothing. Reach the same files through `**`. The build tooling derives entries from a filesystem walk rather than a glob, so this stays latent by construction.
2. **Nx globs cannot target a side folder.** Nx's native matcher has no working spelling. Nothing in the layout needs one, but it forecloses an Nx named input that mentions a side.

See [Extension lifecycles](lifecycles.md) for what happens to these contributions once mounted, and [Architecture](architecture.md) for how a package becomes part of a composition.
