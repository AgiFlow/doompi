---
name: workflow-recovery
description: Recover a failed or interrupted workflow-mcp run so it resumes from its active repair rather than starting over. Use before calling workflow_run with action recover, whenever a run shows stage error or interrupted, or when deciding between recovering a run, launching a fresh one, and deferring it. Covers the evidence to gather first, the three permitted outcomes, the judgement cases, and the files that must never be edited.
---

# Recovering a workflow run

A recovery is **not** a relaunch, and the difference is expensive to get wrong. A
relaunch throws away the run's state and starts again; a recovery resumes the
existing run from its active repair, preserving the worktree and the work already
done. Choosing the wrong one either destroys progress or resumes a run that can
never succeed.

Recovery is also the explicit ownership-transfer path. A replacement Pi session
may recover a terminal failed run launched by an earlier session; the replay is
then stamped to the recovering session. This does not permit cross-session
control of running or completed work.

Read this before calling `workflow_run` with action `recover`.

## 1. Gather evidence first

Never act on the stage alone. Before touching a failed run, collect:

- **Every log source**, not just the first one that looks relevant.
- **Process state** — is anything still alive from the original run?
- **The exact staged `run.json`** for the run.
- **Only the repair referenced by `activeRepairId`.** Other repairs in the
  directory belong to earlier cycles and are not yours to act on.

Use `workflow_run` with action `recovery-evidence` for the terminal `run.json`
and durable `changelog.md`, `context.md`, and progress evidence. This dedicated
action is terminal-only and read-only, including for failures from an earlier
session; it never scrapes that session's live launcher. Generic `status` and
`tail` remain limited to runs owned by this session.

## 2. Choose exactly one outcome

Every failed run resolves to one of three, and never two in the same pass:

| Outcome                      | When                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| **Recover** the existing run | The recorded target is still valid and the failure was transient or an interruption       |
| **Launch fresh**             | The run cannot resume, or the branch has diverged far enough that resuming is meaningless |
| **Defer**                    | A named prerequisite is materially unresolved                                             |

Recovery and a fresh launch each consume one launch from the pass budget.

## 3. Judgement cases

- `interrupted` with a valid failed job — the strong recovery case.
- `failed` with a valid failed job — recoverable when the failure was transient
  and the recorded target remains valid.
- **Empty failed job** — cannot be recovered. Launch fresh if the work is ready,
  otherwise defer.
- **Terminal repair-triage run** — must never be recovered. Launch fresh once the
  work is ready again.
- **Stale branch** — prefer a fresh launch once the branch has diverged enough
  that resuming would rebase onto unrecognisable history.
- **No job id** — the run was launched by hand and is outside dispatch. Report
  it; do not recover it.
- **Blocked** — never recover or launch a run whose job sits in a blocked column.
  A human resolves the blocker first.

## 4. Hard constraints

- **Never edit `issue.md` or `repair.json`.** They are the record of what went
  wrong; editing them destroys the evidence and the repair chain.
- **Never manufacture a recovery target.** If the recorded target is invalid,
  that is a fresh-launch case, not a reason to invent one.
- Prepare `run.json` **only** when verified recovery state requires it.
- Preserve the active repair and the existing worktree identity.
- Treat an “already claimed” result as another recovery winning the race; do
  not launch fresh or retry around the claim.
- Do not use `--dry-run` for a real recovery.

## 5. Verify before reporting

Recover through the launcher recorded for the run. Then confirm **real process
and registry progress**. A `workflow_run` action `recover` call that returns is
not a recovery that succeeded. After ownership has transferred and the replacement run is visible to this
session, check `workflow_run` with action `status` before reporting an outcome.
Say what you recovered, what you skipped and why, and anything still blocked.
