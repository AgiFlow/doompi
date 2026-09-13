# Session lifecycle

Package hooks follow the [plugin lifecycle contract](../../../doompi-core/docs/plugins.md): register, `onStart`, `onStop`, unregister, and `onDispose`. Server readiness waits for required plugin startup; browser reconnects do not restart those plugins.

`doompi-server` owns one session boundary from startup through shutdown. The Pi harness, session services, package facets, and listener live in the same process. A client can disconnect without stopping the runtime, and a later client can recover the current replicated state.

## The ownership model

```text
doompi-server process
  |
  +-- session manager and headless hub
  +-- DirectHarnessRuntime
  +-- typed management and session services
  +-- package facet host and in-process API handlers
  +-- HTTP and WebSocket listener, including /api/pi
  +-- v4 JSONL session journal
```

The server, not a client, owns runtime disposal and history ownership. This gives clients a stable protocol endpoint while the runtime continues processing a turn or while a client reconnects.

## Startup is readiness-ordered

The server publishes the listener only after the runtime and required facets are ready:

```text
parse options and identity
          |
          v
read token and resolve admitted synchronization
          |
          v
validate server.bundle.json and load eligible facets
          |
          v
create DirectHarnessRuntime and prepare the headless host
          |
          v
activate facets and initialize typed session services
          |
          v
bind HTTP and /api/pi
          |
          v
wait for the runtime
```

The executable performs these steps:

1. Parse server options before `--` and keep the remaining values as embedded harness arguments.
2. Read and trim the token file. An empty token stops startup, and the token is never placed in the process argument vector.
3. Resolve session identity and harness options from the caller's repository.
4. Require the admitted synchronized generation and its `server.bundle.json` descriptor. Validate generation, fingerprint, module confinement, and facet scope before importing modules.
5. Create the direct runtime with explicit history ownership, model configuration, session identity, and working directory.
6. Prepare and activate the selected server facets. Required failures stop readiness; optional failures are reported and isolated.
7. Mount in-process package API handlers and initialize the typed session projection.
8. Bind the loopback HTTP listener and authenticated `/api/pi` WebSocket endpoint.

A startup error is written to stderr with a `[doompi-server]` prefix and exits non-zero. Successful startup waits for the direct runtime, not for a client to connect.

## Steady state

Once ready, the server holds a stable session boundary:

| Owned resource                     | Lifetime                         |
| ---------------------------------- | -------------------------------- |
| Session ID and name                | Whole server process             |
| Direct harness runtime             | Whole server process             |
| Typed session state and operations | Whole server process             |
| Package facet registrations        | Until shutdown or facet disposal |
| HTTP and `/api/pi` listener        | Whole server process             |
| Session journal ownership          | Whole server process             |

The session service projects runtime activity into an authoritative snapshot, transient progress, concurrent in-flight items, and bounded presentation events. A client does not need to remain connected for the runtime to update the journal.

Selection and minor-mode changes are applied through the in-process headless host. They update the runtime's tools, resources, and projected composition without changing the server identity or requiring another Pi process.

## Reconnect and replay

A new protocol attachment receives replicated state rather than an old transport backlog. The session state includes the current transcript, phase, model, thinking level, queue, in-flight items, and presentation projection. The session journal remains the durable source for history and is rehydrated when the runtime opens it.

Live presentation events are bounded to 1,024 events or 8 MiB. The state reports a `dropped` count when that window overflows. Latest status, widget, dialog, and custom-entry projections are retained separately, so a reconnect can render current UI state even after older live events were discarded. A branch replacement resets custom presentation state and reports `resetRevision`.

This is recovery state, not an audit log. Clients that need authoritative transcript or configuration data should use the typed snapshot and query operations. A client must not infer missing history from the bounded presentation window.

## Package facet changes

The server loads facets from the admitted descriptor at startup. Rebuilding a package or changing its descriptor does not mutate a running host. Synchronize and restart the session to select a new generation. During shutdown, facet disposers run before the host and runtime release their resources.

## Shutdown and failures

`SIGINT`, `SIGTERM`, runtime exit, and explicit disposal all disable new operations and release resources in ownership order:

1. stop accepting new package and session operations;
2. close active facet registrations and package handlers;
3. stop the headless host and pending extension interactions;
4. close the typed service projection and direct runtime;
5. release history ownership and close the JSONL repository;
6. close the listener and flush bounded telemetry.

A runtime failure is a session failure. The server does not replace it with an alternate process or silently switch to another generation. A history ownership conflict likewise fails closed to avoid concurrent writers.

## Related guides

- [Getting started](getting-started.md) covers launch options and synchronization.
- [IPC](ipc.md) explains `/api/pi`, typed services, HTTP routes, and replay.
- [Session APIs](api.md) explains descriptor loading and handler lifetime.
- [Security](security.md) describes listener, token, history, and trusted-code boundaries.
