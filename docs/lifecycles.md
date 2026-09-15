# Extension lifecycles

[Back to DoomPi](../README.md)

Every DoomPi contribution belongs to a mount, and every mount runs the same stages in the same order. This guide is the stage-level contract behind the summary in [Architecture](architecture.md); read that first for who owns which Cordis root.

There are three hosts. **CLI** is the interactive Pi terminal, **server** is the headless hub, and **web** is the cockpit browser. CLI and server share one implementation. Web does not yet, and the gap is named below.

## The host lifecycle

`createPluginLifecycle` in [`pluginLifecycle/index.ts`](../packages/core/doompi-core/src/services/pluginLifecycle/index.ts) is the single implementation. `definePiExtension` and `defineServerPlugin` both use it, and nothing else does.

```text
mount()
  [abort checkpoint]
  resolve declaration        literal, or a factory that may be async
  hooks = resolved           the assignment that decides what rollback can call
  [abort checkpoint]
  register contributions     each registration records its cleanup internally
  [abort checkpoint]
  started = true             set before onStart is even looked for
  await onStart              external work starts here, never in the factory
  [abort checkpoint]

dispose()
  controller.abort()         synchronous, before any line of the body runs
  await startup              the mount promise, never mount()'s rollback promise
  draining = true
  await onStop               only when started is true
  cleanups in reverse        each awaited, each error collected
  await onDispose            only when hooks was assigned
  throw AggregateError       only if any of the above collected an error
```

The factory builds state. `onStart` begins work that reaches outside the process: sockets, watchers, timers, subscriptions. Splitting them is what makes rollback total, because a mount that never started has nothing outside itself to undo.

### Rollback is not uniform

A throw anywhere in `mount` runs `dispose()`, but what `dispose()` can do depends on how far the mount got. The deciding line is `hooks = resolved`, which only executes after the factory returns.

| Throw location    | `onStop` | recorded cleanups | `onDispose` |
| ----------------- | -------- | ----------------- | ----------- |
| factory (resolve) | skipped  | run               | **skipped** |
| register          | skipped  | run               | run         |
| `onStart`         | **run**  | run               | run         |
| abort after start | run      | run               | run         |

A rejecting factory never sees `onDispose`, because there is no resolved definition to read it from. A factory that allocates must therefore release the resource on its own failure path, or hand it to the host through the declaration, as a service, a channel or a registration, so the helper owns its cleanup. The internal `own()` used above is not reachable from a plugin factory.

When rollback succeeds the original error is rethrown bare. `AggregateError` appears only when cleanup itself also failed.

### Invariants

1. **The signal is already aborted inside every teardown hook.** `onStop`, the recorded cleanups and `onDispose` all see an aborted signal, because `controller.abort()` is called after the disposal promise is constructed but the body is a queued microtask, so the abort lands first. Reading the source top to bottom suggests the opposite. `onStart` is not a teardown hook and runs before any abort.
2. **`onStop` is owed to any mount that reached `started = true`.** That means registration completed _and_ the signal was not already aborted at the checkpoint immediately after it. Within that, a plugin with no `onStart` and a plugin whose `onStart` threw both still get `onStop`. A mount aborted while an async `register` was still in flight does not.
3. **`dispose()` is idempotent, and memoizes failure.** Once cleanup throws, every later `await dispose()` rejects with the same errors and no cleanup re-runs.
4. **Re-entrancy is safe by assignment order.** The disposal promise is assigned before `abort()`, so an abort listener that calls `dispose()` receives the identical promise instead of recursing.
5. **A registration can still be recorded briefly after disposal begins.** `draining` is set only once `startup` settles, so a registration still in flight records its cleanup, and that cleanup runs.
6. **`dispose()` awaits `startup`, never the promise `mount()` returned.** The rollback path awaits `dispose()`, so awaiting it back would deadlock.
7. **A mount happens once.** A second `mount()`, or one after disposal, returns a rejected promise rather than throwing synchronously.
8. **Starting fully is not the same as staying mounted.** The last abort checkpoint runs after `onStart` resolves, so a plugin can complete startup and still be torn down with an `AbortError`.

## Where the hosts differ

|                         | CLI                                                | Server                                              |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------- |
| Helper                  | `definePiExtension`                                | `defineServerPlugin`                                |
| Mounts                  | one per Pi process                                 | one per scope instance                              |
| Context                 | `context`, `pi`, `options`, `runtime`, `signal`    | `context`, `host`, `agent`, `signal`                |
| Events                  | `events`, a record keyed by Pi event name          | `hooks`, an array of `{ event, handle }`            |
| Teardown trigger        | `pi.on('session_shutdown')` plus the Cordis effect | the Cordis effect plus a returned disposer          |
| Unregisters on teardown | its Doom-service registrations only                | everything, through each registration's `dispose()` |

Two consequences of that last row are worth stating plainly.

**The CLI only partly unregisters.** Help resources, tool restrictions, tool overrides and service fibers are bound into child fibers whose effects dispose them, so those do come back out. Everything handed to Pi's own registry stays, because Pi's register calls return no handle: tools, commands, events, providers, renderers, shortcuts and flags. Those are fenced by the aborted signal instead, and the fencing is not uniform. A portable `DoomPluginTool` falls back to the lifecycle signal and throws after teardown, while a native Pi tool declaration registered from a static array carries no signal and can still execute. Prefer the portable contract when teardown correctness matters.

**Server session contributions can vanish silently.** At session scope `agent` is read from the Cordis context, and when it is absent the helper returns early, skipping tools, commands, hooks, resources, restrictions and activities with no error and no notice.

`onStart`, `onStop` and `onDispose` are declared per scope on the server, so one package can hold three independent sets.

## The extension lifecycle

The extension lifecycle is the host lifecycle extended to the browser. Same stages, same vocabulary, three targets.

Web today has one hook, `start(runtime)`, returning a disposer. It is synchronous, and disposers run in reverse. It has no factory form, no `onStart`/`onStop`/`onDispose` split, and no `AbortSignal`. Bringing it onto the shared lifecycle is what makes one vocabulary true rather than aspirational.

Two current web behaviours are worth knowing before then:

- A `start` declared at the root of a `WebPluginDefinition` is never called. Each plugin is rebuilt from its scope contribution alone, so `start` has to sit inside `global`, `workspace` or `session`.
- `startWebPlugins` has no production caller, because the cockpit mounts through `startPluginDefinitions` instead. It is not inert: only the session state drops `start` during the scope merge, so calling it while no session is active would start every global-scope and workspace-scope plugin again.

### Scopes

The three scope names decide different things, and conflating them is the most common mistake.

| Scope       | What it decides                                   |
| ----------- | ------------------------------------------------- |
| `global`    | which extensions are bundled for the machine      |
| `workspace` | which extensions are bundled for the repository   |
| `session`   | which extensions are active for one agent session |

The hub mounts global, workspace, and session facets independently, each with its own lifetime. A server facet reads exactly one generated declaration, `plugin[host.scope]`; the generator copies broader routed contributions into narrower declarations. The cockpit also mounts these scopes independently and merges broader contributions into narrower scopes, replacing a parent's contribution when keys match. It skips `start` during the merge so lifetimes remain separate. Pi has one process mount, with no runtime scope cascade; its generator gathers routed Pi files from the scopes into that one declaration.

Server-side eligibility is two predicates and one escape hatch: the entry must list the requested scope, and some owner must match the active major mode with a layer that is either `default` or active. At session scope with `retainCandidates`, the owner predicate is bypassed so the kernel can apply selection changes without importing a different generation.

## Composition

Extensions reach each other by name and never by import, which is what lets any of them be absent at the next sync.

1. **Relations resolve after every extension installs.** A slot, a fill, an activity group, a tool renderer, a minor mode and a leader binding are all late-bound by name.
2. **Order is a tiebreak, not a dependency.** Install order is `registrationOrder`, then plugin id, then package directory.
3. **A missing counterparty is a diagnostic.** A fill naming a slot no installed plugin declares is recorded and skipped, not thrown.
4. **A collision is first-wins plus a notice, with one exception.** Two packages claiming one plugin id do not fail the cockpit, and the first keeps the name. A Leader Space leaf goes the other way: the later binding keeps the leaf, and the diagnostic is filed against the earlier plugin.

Point 3 has exceptions that do throw, because they are authoring errors rather than composition outcomes: a reserved plugin id, a reserved or unlabeled dock face, the same contribution declared twice inside one plugin, a badly namespaced slot, a malformed leader binding, an empty contribution id or label, and a fill carrying neither a component nor data. These abort the install rather than degrading it.

## Failure policy

One broken extension does not mean the same thing on each host.

| Host                                            | Effect of one failing extension                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| CLI, compiled bundle                            | that entry is skipped, one line goes to stderr, later factories still run                                                 |
| CLI, per-entry loader                           | collected as a problem and raised as a Pi warning at `session_start`                                                      |
| Server, required and eligible facet             | the failed fiber, every installed fiber in reverse, and the root are disposed, then the error is rethrown. Bring-up fails |
| Server, optional facet                          | that fiber is disposed, a notice is emitted, the loop continues                                                           |
| Web, collision or orphan fill                   | a diagnostic; the rest of the cockpit installs                                                                            |
| Web, malformed contribution or throwing `start` | the whole mount aborts and nothing installs                                                                               |

A required facet is only fatal while it is eligible. A retained session candidate that was not initially eligible is downgraded to a notice, on both the load path and the install path.

The two CLI rows are the same failure reaching a user differently. Inside the compiled bundle a per-extension failure is stderr only, because the whole bundle is a single entry to the loader above it. Only a failure of the bundle module itself becomes a notification.

Server facets are imported one at a time and installed one at a time, in bundle order. A generation or fingerprint mismatch throws before any entry is filtered or any module is imported.

## Entry points

| Responsibility                          | Entry point                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Shared lifecycle                        | [`pluginLifecycle/index.ts`](../packages/core/doompi-core/src/services/pluginLifecycle/index.ts) |
| CLI helper                              | [`piExtension.ts`](../packages/core/doompi-core/src/extensions/piExtension.ts)                   |
| Server helper                           | [`serverPlugin.ts`](../packages/core/doompi-core/src/extensions/serverPlugin.ts)                 |
| Web helper                              | [`webPlugin.ts`](../packages/core/doompi-core/src/extensions/webPlugin.ts)                       |
| Portable tool and command contract      | [`pluginContributions.ts`](../packages/core/doompi-core/src/schemas/pluginContributions.ts)      |
| Server facet loading and failure policy | [`serverFacetLoader.ts`](../packages/core/doompi-core/src/server/serverFacetLoader.ts)           |
| Web install, merge and diagnostics      | [`pluginRegistry.ts`](../packages/clients/doompi-web/src/web/lib/pluginRegistry.ts)              |
| Web mount and teardown                  | [`pluginRuntime.ts`](../packages/clients/doompi-web/src/web/lib/pluginRuntime.ts)                |
| Compiled CLI extension set              | [`compiler/index.ts`](../packages/core/doompi/src/compiler/index.ts)                             |

See [Extension layout](extension-layout.md) for the folder convention that declares these contributions, [Architecture](architecture.md) for Cordis root ownership, selection transitions and child isolation, and [Composition and runtime bundling](bundling.md) for how a selection becomes the artifacts these hosts load.
