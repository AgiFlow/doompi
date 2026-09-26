# Server Pi lifecycle audit

DoomPi owns server admission, lifecycle policy, pending input, cancellation policy, and client state. It uses `@earendil-works/pi-agent-core` `AgentHarness`/`AgentLane` for model and tool execution, not `pi-coding-agent` `AgentSession`. Existing coding-agent imports supply tools, resources, settings, and extension compatibility; removing those imports is outside this lifecycle repair.

## Ownership and transitions

```text
web composer -> Chord SessionService -> piSessionRuntime -> directHarnessRuntime
  -> native lane admission -> native drive -> model/tool events
  -> steering/follow-up boundary or targeted cancellation
  -> native operation cleanup -> DoomPi settlement and pending-input decision
  -> authoritative replicated session state -> web controls
```

The native lane owns execution identity and its abort signal. DoomPi owns when an input is admitted, its delivery and scheduling intent, and whether subsequent input may run. Transcript `phase` is presentation (`idle`, `turn`, `compaction`, `retry`), not proof of execution ownership. `run_end` event delivery can outlive the native terminal commit, so DoomPi must preserve identity through its own projection settlement. A transport response acknowledges admission, not model completion or steering consumption.

| Transition     | State owner and data                                                 | Trigger, error, disposal, and client effect                                                                                                                                      |
| -------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open           | Session host and harness; persisted session and native lane          | Asynchronous open; recover pending input and cancellation intent before native interrupted-operation resume; publish snapshot.                                                   |
| Admit          | DoomPi retained-input record and native operation ID                 | Client or extension request; serialize bounded policy changes; reject/retain admission failures, never hold a mutation through model execution.                                  |
| Run            | Native lane `operation` and drive                                    | Native accept/drive; cancellation signal reaches generation and tool drive; publish active operation ID/status.                                                                  |
| Stream/tools   | Native drive, provider and tool signals                              | Async events; stream silence is not idle. Tool effects that ignore cancellation must be fenced against stale results.                                                            |
| Steer/queue    | DoomPi pending record; native inbox only after handoff               | Ack after durable retention; consume at committed native boundary, or keep pending/uncertain. Distinguish delivery kind from permission to wake idle work.                       |
| Abort          | DoomPi pause intent, captured operation ID, native cancellation gate | Persist pause before destructive native abort, then reconcile native pending payloads; remain active until terminal settlement. Stale/duplicate abort cannot target a successor. |
| Complete       | Native terminal commit, DoomPi settlement                            | Normal, aborted, failed and disposed paths reconcile the same retained input; queue scheduling has one owner; publish terminal snapshot after settlement.                        |
| Dispose/reload | Host ownership and native close                                      | Fence admissions and callbacks, cancel active work while dependencies remain available, settle and close; reopen must honor persisted pause.                                     |

## Pi parity and DoomPi policy

Installed Pi packages inspected during this audit are `0.87.1`. Source inspection establishes APIs and intended transitions, not their runtime reliability in DoomPi.

| Behavior                       | Installed Pi low-level behavior                                          | DoomPi requirement                                                                               |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Start and active turn          | Lane accepts one operation ID, drive owns completion                     | Reuse native identity; no second execution engine.                                               |
| Streaming state                | Generation emits messages within a live operation                        | Do not infer idle from token silence or HTTP completion.                                         |
| Abort request/propagation      | Targeted request cancels model signal and tool drive gates               | Scope to displayed ID, preserve visible aborting state; test nested side effects.                |
| Abort completion               | Native abort removes steer/follow-up pending payloads and returns them   | DoomPi policy: retain unconsumed input and pause, not silently discard or auto-drain.            |
| Steering/multiple steering     | Native inbox persists FIFO, selection one or all per configured boundary | Durable acknowledgement, preserve unconsumed input and queue mode.                               |
| Queue while busy               | Native follow-up participates in later boundary                          | Keep eligibility and ordering; support atomic promotion before handoff.                          |
| Queue while idle               | Native follow-up enqueue alone does not drive                            | Preserve intentional held voice/extension behavior; wake only explicitly automatic product work. |
| Remove/promote                 | Native removal by ID exists; no public atomic reclassification           | DoomPi pending record owns pre-handoff remove/promote; return explicit post-handoff outcome.     |
| Pop after completion           | Native boundary commits transcript placement with inbox removal          | DoomPi schedules eligible next work exactly once and reconciles native consumption.              |
| Tool abort/errors              | Native gates suppress forward progress, terminal records cover failures  | Fence late effects; preserve input and emit terminal state on all error paths.                   |
| Disconnect                     | Accepted server work outlives client transport                           | Reconnect from durable lifecycle/queue snapshot, never from event ring alone.                    |
| Session disposal/Cordis reload | Harness closes gates; DoomPi owns host teardown                          | Stop admission before dependencies close; reopen reconciles pause and unfinished handoffs.       |
| Turn completion/usage          | Native result and usage records                                          | Project final result/usage once, identity-scoped, after settlement.                              |

Higher-level `pi-coding-agent` lifecycle is a comparison reference only. DoomPi does not delegate server lifecycle to it. Pi-native `nextRun`, explicit extension `triggerTurn`, non-triggering append, custom messages, and queued voice capture retain their existing meanings.

## Evidence and acceptance

**Verified from source:** `directHarnessRuntime.ts` uses the native harness, `piSessionRuntime.ts` previously gated steer/abort by transcript phase, and native cancellation removes pending steer/follow-up entries. `headlessSessionHost.ts` deliberately leaves an idle follow-up enqueue-only for voice capture. Native queue IDs must not be regenerated from presentation revisions.

**Verified in controlled tests:** real harness cancellation retains queued input and pauses until explicit resume; duplicate steers preserve separate IDs; SQLite close/reopen retains pause and queue; idle automatic input drains after reopening. Core service tests cover lifecycle ordering and targeted controls. Browser Playwright exercises queue remove/clear and abort/resume controls, while style-system renders QueueSheet in a headless browser.

**Not verified with a live provider:** external tool side effects, a real Cordis process replacement, and provider cancellation timing. An uncertain native handoff stays visible without blind replay. Native transcript placement proves delivery at a boundary, not that the model acted on an instruction; external tool side effects cannot be promised exactly once across a crash.

The focused checks live in `packages/core/doompi-core/tests/runtime/unit/adapters/server/directHarnessLifecycle.test.ts` and `packages/clients/doompi-web/tests/e2e/states.spec.ts`. Record command results and live-provider findings separately from source inspection.
