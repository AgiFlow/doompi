## 0.0.1-alpha.4 (2026-09-18)

### 🩹 Fixes

- **root:** stabilize release validation and packaged builds ([1c123b97](https://github.com/AgiFlow/doompi/commit/1c123b97))

### ❤️ Thank You

- vuongngo

## 0.0.1-alpha.3 (2026-09-17)

This was a version bump only for @agimon-ai/doompi-build to align it with other projects, there were no code changes.

## 0.0.1-alpha.2 (2026-09-16)

### 🚀 Features

- move voice, plan, workflow and computer-use onto declared API routes ([bd524ece](https://github.com/AgiFlow/doompi/commit/bd524ece))
- **core,git:** one package-resource reader, and stop one bad file killing a session ([d34b9a85](https://github.com/AgiFlow/doompi/commit/d34b9a85))
- complete folder-based extension migration ([6ad1d3eb](https://github.com/AgiFlow/doompi/commit/6ad1d3eb))
- complete extension layout migration ([9047a61c](https://github.com/AgiFlow/doompi/commit/9047a61c))
- finish folder layout migration and warn subagents ([79ac3117](https://github.com/AgiFlow/doompi/commit/79ac3117))
- adopt folder-based extension layout ([e72511ee](https://github.com/AgiFlow/doompi/commit/e72511ee))
- **doompi-task:** adopt folder-based extension layout ([1d832843](https://github.com/AgiFlow/doompi/commit/1d832843))
- **doompi-team:** colocate session routes and root lifecycle ([2392f201](https://github.com/AgiFlow/doompi/commit/2392f201))
- **doompi-build:** add root.ts, the scope constructor ([230b4698](https://github.com/AgiFlow/doompi/commit/230b4698))
- **doompi-build:** make the side axis logic against presentation ([d79e35d6](https://github.com/AgiFlow/doompi/commit/d79e35d6))
- **doompi-build:** build contributions after services, and route two more surfaces ([a28daca9](https://github.com/AgiFlow/doompi/commit/a28daca9))
- **doompi-build:** give a routed factory its host's real context ([d49926c9](https://github.com/AgiFlow/doompi/commit/d49926c9))
- **doompi-build:** build the browser half instead of shipping source ([c9a8217e](https://github.com/AgiFlow/doompi/commit/c9a8217e))
- **doompi-build:** derive the exports map, with types, and stop minifying ([48eda97e](https://github.com/AgiFlow/doompi/commit/48eda97e))
- **vibe-lint-plugin-doom-extension:** make the legacy roots the migration worklist ([bf652c1d](https://github.com/AgiFlow/doompi/commit/bf652c1d))
- **doompi-core:** type what a folder-routed file may export ([122fd491](https://github.com/AgiFlow/doompi/commit/122fd491))
- **doompi-build:** write generated entries and add the tsdown preset ([d840cfd1](https://github.com/AgiFlow/doompi/commit/d840cfd1))
- **doompi-build:** render generated entries from a scanned tree ([ffa355d5](https://github.com/AgiFlow/doompi/commit/ffa355d5))
- **doompi-build:** resolve a scanned tree to per-host contributions ([16076420](https://github.com/AgiFlow/doompi/commit/16076420))
- **doompi-build:** add the folder-convention scanner ([aedc8424](https://github.com/AgiFlow/doompi/commit/aedc8424))

### 🩹 Fixes

- **core:** synchronize extension session writes ([e08b2b0c](https://github.com/AgiFlow/doompi/commit/e08b2b0c))
- **task:** only count live delegations as running activity ([5571a789](https://github.com/AgiFlow/doompi/commit/5571a789))
- **team,task,core:** wake the headless agent when a subagent finishes ([694c76d9](https://github.com/AgiFlow/doompi/commit/694c76d9))
- **skill:** follow symlinked skill directories and reconcile $ on domain switch ([f62c2b72](https://github.com/AgiFlow/doompi/commit/f62c2b72))
- **root:** repair references after the core package split ([603cfb9a](https://github.com/AgiFlow/doompi/commit/603cfb9a))
- **doompi-build:** a cockpit channel is not a factory ([0006e979](https://github.com/AgiFlow/doompi/commit/0006e979))
- **doompi-build:** stop the build rewriting package.json ([5f6b0990](https://github.com/AgiFlow/doompi/commit/5f6b0990))
- **vibe-lint-plugin-doom-extension:** teach the layout rules about routed packages ([ba952530](https://github.com/AgiFlow/doompi/commit/ba952530))
- **doompi-build:** never resolve a frontend export ([455457e3](https://github.com/AgiFlow/doompi/commit/455457e3))
- **doompi-build:** pass services through and keep generated entries format-clean ([0968406f](https://github.com/AgiFlow/doompi/commit/0968406f))

### ❤️ Thank You

- Vuong Ngo
- vuongngo