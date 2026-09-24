---
name: doompi-debug-agent
description: Debug a DoomPi agent using session-scoped failure and usage evidence. Distinguish missing telemetry from a healthy run, diagnose expensive or failed tools, and investigate deeper traces without exposing secrets or changing the sink.
---

# Debug a DoomPi agent

Start with the user's symptom and an expected outcome. Identify the affected session and the shortest reproduction. Do not attribute a failure to the model before checking the tools and runtime it depends on.

## Read captured evidence

While Help is active, call `help_status` to see which diagnostics are actually available. Use `diagnose_agent` for the current session, initially with the default one-day window. Use `period: week` only when the relevant run is older. The tool has no arbitrary session or filesystem selector.

The result distinguishes unavailable data, an empty window, and captured evidence. `capturedIssues` describes the records inspected, not every failure that ever happened. Zero captured records does not establish that telemetry was working. Token coverage describes usage records, not completeness of the event stream. Tool token samples belong to the containing turn and are not exclusive tool cost.

If setup or capabilities are suspect, use `diagnose_setup` and the configuration, domain, mode, or skill guidance identified by the failed check. Preserve the current selection and unrelated settings.

## Investigate beyond the summary

The diagnostic deliberately omits prompts, raw error messages, tool inputs, and trace bodies. It does not open a sink or repair logging. Use existing authorized repository tools and the installed log-sink CLI only when deeper investigation is necessary. Resolve the same sink identity as the writer, keep queries restricted to the current session, and inspect the CLI's installed help before selecting unsupported query options. Verify trace ownership against that session before reading a trace; a guessed trace ID is not authorization.

When no shell or trace reader is available, report that capability limitation. Do not invent evidence or enable a server, domain, or permission merely to make a command available.

## Propose and verify a repair

Separate observations from hypotheses. Present the smallest change and the expected verification. Configuration changes, model changes, package installation, authentication, restarts, and repairs use existing approval and permission boundaries. Help activation grants none of those actions by itself.

Never clear logs, restart or stop a sink as part of diagnosis, or paste credentials and raw private logs into a report. After an authorized change, reproduce the original symptom and report the observed result and remaining evidence gaps.
