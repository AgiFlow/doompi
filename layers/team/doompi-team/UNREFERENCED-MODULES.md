# Unreferenced modules

**0 modules unreachable.** Every module under `src/` is reachable from an entry
point.

The 18 modules / 4,481 lines this file previously listed were deleted in the
Phase 1 cleanup, along with chain mode, the shared task board, scheduled runs,
nested depth>1 event routing, the deliverable guard, auto-drain, session
revival, and the turn/spawn budgets. See the plan for the full removal set and
the reasoning behind each cut.

## Method

A static walk of every relative `from '...'` import under `src/`, counting
inbound references per file. Entry points are excluded because having no
importer is what makes them entry points: `index.ts`, `env.ts`,
`extensions/pi.ts`, `api/*`, plus the two resolved by raw path rather than by
`import` - `runs/sdk-runner-entry.ts` (spawned as a child process) and
`extensions/subagent-prompt-runtime-entry.cts` (located on disk by
`pi-args.ts`). All are declared in `tsdown.config.ts`.

External consumers cannot reach anything not listed there: `tsdown.config.ts`
filters the package exports map to a closed allowlist.

## Regenerating

Run this after any deletion: removing a module can orphan the ones it was the
last importer of, so re-run until it reports zero.

```bash
cd packages/core/doompi-team
python3 - <<'PY'
import os, re, collections
files = [os.path.normpath(os.path.join(dp, f))
         for dp, _, fn in os.walk("src") for f in fn
         if f.endswith((".ts", ".cts", ".mts"))]
refs = collections.Counter()
for f in files:
    for m in re.findall(r"""from\s+['"]([^'"]+)['"]""", open(f, encoding="utf-8").read()):
        if m.startswith("."):
            refs[os.path.normpath(os.path.join(os.path.dirname(f), m))] += 1
entries = {"src/index.ts", "src/env.ts", "src/extensions/pi.ts",
           "src/api/capability-ceiling.ts",
           "src/api/delegation.ts", "src/runs/sdk-runner-entry.ts",
           "src/extensions/subagent-prompt-runtime-entry.cts"}
rows = [(sum(1 for _ in open(f, encoding="utf-8")), f)
        for f in files if refs[f] == 0 and f not in entries]
for n, f in sorted(rows, reverse=True):
    print(f"{n:6d}  {f}")
print(f"\n{len(rows)} modules, {sum(n for n, _ in rows)} lines")
PY
```
