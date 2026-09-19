# Extension lifecycles

[Back to DoomPi](../README.md)

Every DoomPi contribution belongs to a mount. The mount decides when work may start, what gets rolled back after a failure, and how cleanup runs. This guide gives the exact ordering behind [Architecture](architecture.md), which explains who owns each Cordis root.

DoomPi has three hosts. **CLI** is the interactive Pi terminal, **server** is the headless hub, and **web** is the cockpit browser. CLI and server use the shared lifecycle below. Web still uses a smaller contract, described later.

## The host lifecycle

`createPluginLifecycle` in [`pluginLifecycle/index.ts`](../packages/core/doompi-core/src/services/pluginLifecycle/index.ts) is the shared implementation. Both `definePiExtension` and `defineServerPlugin` use it.

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

Use the factory to build state. Use `onStart` for work that reaches outside the mount, such as sockets, watchers, timers, and subscriptions. This split makes rollback tractable: a mount that never starts should have no external work to stop.

### Rollback is not uniform

Any error in `mount` runs `dispose()`. What cleanup can run depends on how far startup got. The key assignment is `hooks = resolved`, which happens only after the factory returns.

| Throw location    | `onStop` | recorded cleanups | `onDispose` |
| ----------------- | -------- | ----------------- | ----------- |
| factory (resolve) | skipped  | run               | **skipped** |
| register          | skipped  | run               | run         |
| `onStart`         | **run**  | run               | run         |
| abort after start | run      | run               | run         |

A rejecting factory never reaches `onDispose`, because no resolved definition exists yet. If a factory allocates something, it must release that resource on its own failure path. Better, hand the resource to the host through the declaration as a service, channel, or registration so the helper owns cleanup. Plugin factories cannot call the internal `own()` shown above.

If rollback succeeds, the original error is rethrown unchanged. DoomPi uses `AggregateError` only when cleanup also fails.

### Invariants

1. **Every teardown hook sees an aborted signal.** `onStop`, recorded cleanups, and `onDispose` all run after `controller.abort()`. The disposal body is queued as a microtask, so this remains true even though the promise is constructed first. `onStart` runs before any abort.
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

The last row has two practical consequences.

**The CLI only partly unregisters.** Help resources, tool restrictions, tool overrides, and service fibers live in child fibers, so disposal removes them. Pi's own registration calls return no handle, so registered tools, commands, events, providers, renderers, shortcuts, and flags remain in Pi's registry. DoomPi fences them with the aborted signal where it can, but that fencing is not uniform. A portable `DoomPluginTool` uses the lifecycle signal and throws after teardown. A native Pi tool from a static array has no lifecycle signal and may still execute. Prefer the portable contract when teardown correctness matters.

**Server session contributions can vanish silently.** At session scope `agent` is read from the Cordis context, and when it is absent the helper returns early, skipping tools, commands, hooks, resources, restrictions and activities with no error and no notice.

`onStart`, `onStop` and `onDispose` are declared per scope on the server, so one package can hold three independent sets.

## The extension lifecycle

The intended extension lifecycle covers all three hosts with the same stages and vocabulary. The browser has not reached that contract yet.

Today, web plugins have one synchronous hook: `start(runtime)`, which returns a disposer. Disposers run in reverse order. There is no factory form, no `onStart`/`onStop`/`onDispose` split, and no `AbortSignal`.

Two current web behaviours are worth knowing before then:

- A `start` declared at the root of a `WebPluginDefinition` is never called. Each plugin is rebuilt from its scope contribution alone, so `start` has to sit inside `global`, `workspace` or `session`.
- `startWebPlugins` has no production caller, because the cockpit mounts through `startPluginDefinitions` instead. It is not inert: only the session state drops `start` during the scope merge, so calling it while no session is active would start every global-scope and workspace-scope plugin again.

### Scopes

The three scope names answer different ownership questions:

| Scope       | What it decides                                   |
| ----------- | ------------------------------------------------- |
| `global`    | which extensions are bundled for the machine      |
| `workspace` | which extensions are bundled for the repository   |
| `session`   | which extensions are active for one agent session |

The hub mounts global, workspace, and session facets independently, each with its own lifetime. A server facet reads exactly one generated declaration, `plugin[host.scope]`; the generator copies broader routed contributions into narrower declarations. The cockpit also mounts these scopes independently and merges broader contributions into narrower scopes, replacing a parent's contribution when keys match. It skips `start` during the merge so lifetimes remain separate. Pi has one process mount, with no runtime scope cascade; its generator gathers routed Pi files from the scopes into that one declaration.

Server-side eligibility is two predicates and one escape hatch: the entry must list the requested scope, and some owner must match the active major mode with a layer that is either `default` or active. At session scope with `retainCandidates`, the owner predicate is bypassed so the kernel can apply selection changes without importing a different generation.

## Composition

Extensions connect by name, not by importing each other's implementations. That lets any extension be absent after the next sync.

1. **Relations resolve after every extension installs.** A slot, a fill, an activity group, a tool renderer, a minor mode and a leader binding are all late-bound by name.
2. **Order is a tiebreak, not a dependency.** Install order is `registrationOrder`, then plugin id, then package directory.
3. **A missing counterparty is a diagnostic.** A fill naming a slot no installed plugin declares is recorded and skipped, not thrown.
4. **A collision is first-wins plus a notice, with one exception.** Two packages claiming one plugin id do not fail the cockpit, and the first keeps the name. A Leader Space leaf goes the other way: the later binding keeps the leaf, and the diagnostic is filed against the earlier plugin.

Some problems still throw because they are authoring errors, not normal composition outcomes: a reserved plugin id, a reserved or unlabeled dock face, the same contribution declared twice inside one plugin, a badly namespaced slot, a malformed leader binding, an empty contribution id or label, or a fill with neither a component nor data. These abort installation instead of degrading it.

## Failure policy

Failure policy depends on the host and whether the contribution is required.

| Host                                            | Effect of one failing extension                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| CLI, compiled bundle                            | that entry is skipped, one line goes to stderr, later factories still run                                                 |
| CLI, per-entry loader                           | collected as a problem and raised as a Pi warning at `session_start`                                                      |
| Server, required and eligible facet             | the failed fiber, every installed fiber in reverse, and the root are disposed, then the error is rethrown. Bring-up fails |
| Server, optional facet                          | that fiber is disposed, a notice is emitted, the loop continues                                                           |
| Web, collision or orphan fill                   | a diagnostic; the rest of the cockpit installs                                                                            |
| Web, malformed contribution or throwing `start` | the whole mount aborts and nothing installs                                                                               |

A required facet is fatal only while it is eligible. A retained session candidate that was not initially eligible is downgraded to a notice on both the load and install paths.

The two CLI rows describe the same failure through different loaders. Inside a compiled bundle, a per-extension failure only reaches stderr because the outer loader sees the whole bundle as one entry. Only a failure of the bundle module itself becomes a notification.

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
| Compiled CLI extension set              | [`compiler/index.ts`](../packages/cli/doompi/src/compiler/index.ts)                              |

See [Extension layout](extension-layout.md) for the folder convention that declares these contributions, [Architecture](architecture.md) for Cordis root ownership, selection transitions and child isolation, and [Composition and runtime bundling](bundling.md) for how a selection becomes the artifacts these hosts load.
