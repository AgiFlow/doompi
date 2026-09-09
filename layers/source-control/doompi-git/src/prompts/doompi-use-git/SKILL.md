---
name: doompi-use-git
description: 'Use @agimon-ai/doompi-git: Git worktree sessions for DoomPi: spawn an isolated worktree with its own session and manage it from the parent'
---

# Worktree sessions

`run_worktree` creates a git worktree and starts a DoomPi session inside it. The
new session appears nested under the current one in the SESSIONS rail, so a
parent can hand off a branch of work and keep its own checkout untouched.

Worktrees live outside the repository, under `~/.pi/.doom/git/worktrees`. That
is deliberate: a worktree inside the repository resolves workspace imports to
the parent checkout and silently builds the wrong code.

## When to use it

Use a worktree when work needs its own branch **and** its own checkout at the
same time: a long refactor you want to leave half-finished, a risky migration,
or two features that touch the same files.

Do not reach for it to parallelise work that shares a branch. Two sessions on
one branch in two checkouts will fight, and git refuses the second worktree.

The new checkout has no dependencies installed: `spawn_worktree` runs git and
nothing else, whatever language the repository is in. Install them in the
worktree before building or testing there.

## Actions

```
run_worktree { action: 'spawn_worktree', branch: 'wt/fix-auth' }
run_worktree { action: 'list' }
run_worktree { action: 'status', id: 'a1b2c3d4' }
run_worktree { action: 'merge', id: 'a1b2c3d4' }
run_worktree { action: 'close_worktree', id: 'a1b2c3d4' }
run_worktree { action: 'prune', dryRun: true }
```

`spawn_worktree` takes `branch`, and optionally `baseRef` (defaults to the
current branch), `name` for the rail, and `task` as the session's first message.
Every other action identifies a worktree by the short `id` that `list` prints,
never by path or branch.

## What it refuses, and why

- **`close_worktree` on a dirty tree.** It names the uncommitted files and stops.
  Pass `force: true` only after reading that list. The files are gone after.
- **`merge` when the parent checkout is dirty.** The merge lands in the parent,
  so uncommitted edits there would be folded into a merge commit nobody meant to
  make. Commit or stash first.
- **`spawn_worktree` on a branch that already has a worktree.** Close the
  existing one or pick another branch.
- **`prune` never deletes a worktree holding uncommitted work**, and never
  touches a directory this tool did not create. It reports those instead.

Run `prune` with `dryRun: true` first. The plan tells you exactly what would be
removed, forgotten, and left alone.

## Notes

- A worktree session is a peer, not a subagent. It has its own context and its
  own turn loop, and it does not report back when it finishes.
- Closing the parent does not close its worktree sessions. They keep running and
  stay in the rail.
- `spawn_worktree` needs the cockpit running, because the cockpit owns session
  lifecycle. Without it the tool says so rather than half-creating anything.
