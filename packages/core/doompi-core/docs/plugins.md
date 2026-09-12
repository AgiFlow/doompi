# Plugin declarations and lifecycle

`definePiExtension` and `defineServerPlugin` own registration and the Cordis lifecycle. Packages declare contributions and optional lifecycle hooks. A plugin with only tools or commands needs no lifecycle code.

Pi declarations are flat. Server declarations select explicit `global`, `workspace`, and `session` scopes. Each mounted scope owns an independent instance. Creating or reconnecting a browser client does not create another server plugin instance.

## Simple declarations

```ts
import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { tools } from '../tools/documentTools';
import { command } from '../controllers/documentCommand';

export default definePiExtension({
  name: '@example/documents',
  tools,
  commands: [command],
});
```

```ts
import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import { tools } from '../tools/documentTools';
import { command } from '../controllers/documentCommand';
import { api } from '../controllers/documentApi';

export default defineServerPlugin({
  name: '@example/documents',
  session: { api: [api], tools, commands: [command] },
});
```

Contribution fields are nouns: `tools`, `commands`, `resources`, `toolRestrictions`, `services`, `api`, `channels`, and `methods`. Host-specific contributions retain their host's types. Session-only contributions are rejected in server global and workspace scopes.

`services` composes Cordis service plugins. The helper owns their fibers, waits for their readiness before registering dependent contributions, and disposes them automatically. Pi's `providers` field is separate: it declares native model providers.

## Per-mount state

Use a factory when the plugin needs mutable state. Pi accepts `definePiExtension(name, factory)`. A server scope accepts the same factory form as its value.

```ts
export default definePiExtension('@example/documents', (context) => {
  const controller = createDocumentController(context.options);
  return {
    tools: controller.tools,
    commands: controller.commands,
    onStart() {
      controller.start(context.signal);
    },
    onStop() {
      controller.stop();
    },
    onDispose() {
      controller.dispose();
    },
  };
});
```

The factory runs once per mount. It constructs local state and declarations, and may be async when configuration or filesystem discovery determines the contributions. The helper awaits the result before registration and `onStart`. Use the supplied signal for cancellable discovery. Start timers, subscriptions, network requests, and other external work in `onStart`. This lets startup failure and shutdown use the same cleanup path. Do not retain session state in module variables or share a stateful factory result between mounts.

All hooks are optional. Omit hooks the controller does not need. Do not add empty methods or return `undefined` to satisfy an interface. Do not write `onDispose` merely to remove declared contributions: the helper already owns them.

## Lifecycle order

| Stage                | Owner and behavior                                                                      |
| -------------------- | --------------------------------------------------------------------------------------- |
| Create               | The helper creates the typed context and awaits the scope's declaration.                |
| Register             | The helper installs contributions, recording every acquired registration.               |
| `onStart(context)`   | The plugin starts its own work. The helper awaits completion before the mount is ready. |
| Running              | Registered handlers respond to the host.                                                |
| `onStop(context)`    | The plugin stops its work while its registrations are still owned.                      |
| Unregister           | The helper releases owned registrations in reverse acquisition order.                   |
| `onDispose(context)` | The plugin performs any remaining final instance cleanup.                               |

Hooks return `void` or `Promise<void>`. `onStart` does not return a cleanup function. Use the explicit `onStop` hook instead. `onStop` is also valid without `onStart` and runs when registration reached the start stage.

Shutdown aborts the instance's `signal` immediately, waits for pending factory discovery or a startup hook to settle, then runs cleanup. A startup hook waiting on external work must honor the signal. The helper does not run `onStop` concurrently with `onStart`.

If disposal interrupts discovery, the returned contributions are never registered and their `onDispose` runs. A rejecting factory must clean up any resources it acquired before returning; its error remains visible and the helper releases its host ownership.

Calling dispose repeatedly shares the same completion and does not rerun hooks. Registration failure skips the start and stop stages, removes partial registrations, and calls `onDispose`. If `onStart` fails, shutdown also calls `onStop`. Every cleanup is attempted even when another cleanup throws. Startup errors remain visible alongside cleanup failures.

Native Pi tool and event registrations remain owned by Pi's extension runtime. Doom service registrations and Cordis fibers have explicit disposable handles owned by the helper. Plugins must not create a second host connection or manually register these contributions in their entries.

## Contexts and dependencies

Hooks and factories receive one typed context, without positional registrar/state/host parameters:

- Pi: `context`, `pi`, `options`, `runtime`, and `signal`.
- Server: `context`, `host`, optional session `agent`, and `signal`.

Native host access exists for host-specific capabilities. Use named `requireDoom*` accessors for required Doom services and the corresponding `readDoom*` accessor for intentionally optional services. Declared service requirements keep their existing host readiness semantics.

Optional Pi help and tool-surface providers can arrive later. Their contributions bind when available and rebind when that provider is replaced. This does not rerun the plugin factory or its lifecycle hooks. Losing a required Cordis dependency can unmount its dependent plugin; a later mount creates a new instance.

## Shared tools and commands

Declare portable tools with `defineTool` and portable commands with `defineCommand`, exported from both plugin entry contracts. Tool parameters are inferred from the supplied TypeBox schema.

A portable tool receives `execute(input, execution)`. Its execution context supplies `toolCallId`, `cwd`, `signal`, `update`, and `notify`. A command receives `execute(args, execution)` with `cwd`, `signal`, and `notify`. This context exposes only shared capabilities, rather than pretending Pi provides an entire server context.

Use `executionMode: 'serial'` for serial execution. The Pi helper translates it to Pi's native `sequential` setting. Thrown tool errors follow host conventions: Pi propagates them to its tool runner; the server returns an error result. Notifications use the server client or Pi UI when available.

Host-specific tools and commands can still use native declarations. Pi tool presentation overrides belong in the Pi declaration's `pi` options, leaving the shared tool handler independent of its renderer.

Server methods use `defineServerMethod(schema, handler)` inside `methods: [...]`. This preserves request and response inference before methods are combined into a heterogeneous array. Channels remain factories so each mount gets its own channel instance.

## Minor modes and host events

Plugin mounting is separate from entering or leaving a minor mode. Modes may expose multiple actions and may be entered from other features. The core does not impose an activate/deactivate toggle model.

Minor-mode definitions and registration belong to `@agimon-ai/doompi-minor-mode`. Add `piMinorModes(owners)` or `serverMinorModes(owners)` to `services`. These feature helpers attach and detach catalog handles. Owner actions publish their resulting state automatically; external state changes can call `owner.publish()`.

Pi native events use an `events` object keyed by event name, with each event's native input and result type. Server agent events use the native `hooks` contribution array. These events are separate from `onStart`, `onStop`, and `onDispose`.

## Package layout and exports

- `extensions/`: host declarations and composition.
- `controllers/`: API and command request handling.
- `tools/`: tool declarations using services and models.
- `services/{serviceName}/`: behavior, with local `index.ts`, `type.ts`, and implementation files.
- `models/`: state and domain models.
- `constants/`, `schemas/`, and `types/`: their corresponding public or internal contracts.
- `exports/`: flat public forwarding modules for consumers.

Do not create `adapters/`, `container/`, or nested export directories. Internal imports omit file extensions and `/index`. Configure tsdown entries directly from `src/extensions` and `src/exports`; do not add extension reexports merely to make bundling work. Preserve the Pi callable default, server Cordis default, and browser `webPlugin` loader exports.

VibeLint preflight rejects vanilla host wiring, old setup/teardown callbacks, imperative contribution callbacks, and forbidden layout patterns. Follow the generated templates and the Author pilot. Browser plugin mounting has its own UI contract; this guide's new hooks apply to Pi and server.

## Live Pi tools

Pi plugins may set `tools` to an array or a typed `PiToolCollection`:

```ts
interface PiToolCollection {
  snapshot(): readonly PiToolContribution[];
  subscribe(listener: () => void): () => void;
}
```

Snapshots contain the same native or portable declarations accepted by static arrays. Use `definePiTool` for native definitions whose renderers depend on concrete schema or result-detail types. The helper captures their typed registration without widening those handlers.

Collections must reuse immutable declaration objects for unchanged tools. The helper subscribes before reading the first snapshot. Removing a declaration makes its wrapper unavailable and aborts its execution signal. Returning the unchanged object re-enables it. A different object with the same name retires the old wrapper and registers the replacement, updating native metadata, execution, and rendering. Previously captured wrappers remain unavailable. Cache unchanged declarations when producing snapshots.

Pi cannot unregister tools, so unavailable wrappers remain in its registry. Plugin shutdown aborts their execution signals and removes the subscription. An invalid initial snapshot fails startup; an invalid later snapshot leaves existing wrappers unavailable until a valid snapshot arrives. Duplicate names are invalid. Tools must honor the supplied signal to cancel work already in progress.

Minor-mode factories preserve the full typed execution object: `defineMinorMode<Runtime, Execution>` passes it to `handleAction(runtime, actionId, argumentsValue, execution)`. The default execution type requires only `signal`; native hosts can supply their context and operation metadata without importing host types into the neutral factory.

Reactive tool restrictions use a `source`, `restrict`, and optional `subscribe(listener)` returning an unsubscribe function. Pi restrictions transform the current tool-name list. Server restrictions return `{ when, allowedTools }` with optional selection-state conditions. The helper refreshes the active registration when the listener fires and removes the listener during disposal. Static server restriction objects remain sufficient when the allowed tools never change.

When the set of Pi minor modes changes at runtime, `piMinorModes` accepts a collection with typed `snapshot()` and `subscribe(listener)` methods. Return stable owner objects for unchanged modes. The helper removes missing owners, replaces changed identities, attaches new owners, and owns unsubscription and final cleanup. The same source and mode id may appear only once in a snapshot. A global opt-in can therefore remove a mode entirely from the catalog without manual registration.
