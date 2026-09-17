## 0.0.1-alpha.74 (2026-09-17)

### 🚀 Features

- finalize session MCP and workspace updates ([3f43e555](https://github.com/AgiFlow/doompi/commit/3f43e555))
- add session MCP and style system support ([5912ce17](https://github.com/AgiFlow/doompi/commit/5912ce17))

### 🩹 Fixes

- stabilize synchronized extension bundles ([97886fcd](https://github.com/AgiFlow/doompi/commit/97886fcd))
- stabilize session runtime and desktop release ([eb07a2c3](https://github.com/AgiFlow/doompi/commit/eb07a2c3))
- **core:** declare tanstack store at runtime ([536a056a](https://github.com/AgiFlow/doompi/commit/536a056a))

### 🧱 Updated Dependencies

- Updated @agimon-ai/doompi-telemetry to 0.0.1-alpha.71
- Updated @agimon-ai/doompi-web-security to 0.0.1-alpha.34
- Updated @agimon-ai/vibe-lint-plugin-doom-core to 0.0.1-alpha.5

### ❤️ Thank You

- vuongngo

## 0.0.1-alpha.73 (2026-09-16)

### 🚀 Features

- **core,team:** bridge Pi events and intercom messages ([e7f0e075](https://github.com/AgiFlow/doompi/commit/e7f0e075))
- **core:** wire Pi extensions into harness events, context and compaction ([882c1a0f](https://github.com/AgiFlow/doompi/commit/882c1a0f))
- move voice, plan, workflow and computer-use onto declared API routes ([bd524ece](https://github.com/AgiFlow/doompi/commit/bd524ece))
- **core,log,prompt:** path parameters, and two more adopters ([4c35743f](https://github.com/AgiFlow/doompi/commit/4c35743f))
- **core:** advertise server skills instead of only billing for them ([f0f27c07](https://github.com/AgiFlow/doompi/commit/f0f27c07))
- take package docs and redundant state out of the system prompt ([2976d638](https://github.com/AgiFlow/doompi/commit/2976d638))
- **core,build,file-edit:** generated RPC clients with build-injected URL shapes ([afdfd7c6](https://github.com/AgiFlow/doompi/commit/afdfd7c6))
- **core,git:** one package-resource reader, and stop one bad file killing a session ([d34b9a85](https://github.com/AgiFlow/doompi/commit/d34b9a85))
- **team:** add generated agent identity and fix headless fork capture ([ce6404e7](https://github.com/AgiFlow/doompi/commit/ce6404e7))
- complete folder-based extension migration ([6ad1d3eb](https://github.com/AgiFlow/doompi/commit/6ad1d3eb))
- **doompi-task:** adopt folder-based extension layout ([1d832843](https://github.com/AgiFlow/doompi/commit/1d832843))
- **doompi-team:** colocate session routes and root lifecycle ([2392f201](https://github.com/AgiFlow/doompi/commit/2392f201))
- **doompi-build:** add root.ts, the scope constructor ([230b4698](https://github.com/AgiFlow/doompi/commit/230b4698))
- **doompi-build:** make the side axis logic against presentation ([d79e35d6](https://github.com/AgiFlow/doompi/commit/d79e35d6))
- **doompi-core:** type what a folder-routed file may export ([122fd491](https://github.com/AgiFlow/doompi/commit/122fd491))
- **doompi-core:** add defineWorkspaceStore ([546774db](https://github.com/AgiFlow/doompi/commit/546774db))

### 🩹 Fixes

- **core:** synchronize extension session writes ([e08b2b0c](https://github.com/AgiFlow/doompi/commit/e08b2b0c))
- **core:** let a route answer bytes without spending its body read ([7ccb3a86](https://github.com/AgiFlow/doompi/commit/7ccb3a86))
- **core,build,tooling:** close four gaps the parallel adopters found ([a0caad6d](https://github.com/AgiFlow/doompi/commit/a0caad6d))
- **core:** let the RPC client carry an abort signal ([2db8523c](https://github.com/AgiFlow/doompi/commit/2db8523c))
- **task:** only count live delegations as running activity ([5571a789](https://github.com/AgiFlow/doompi/commit/5571a789))
- **team,task,core:** wake the headless agent when a subagent finishes ([694c76d9](https://github.com/AgiFlow/doompi/commit/694c76d9))
- **core,voice:** stop mode-gated tools leaking into the headless surface ([56bea74a](https://github.com/AgiFlow/doompi/commit/56bea74a))
- **root:** repair references after the core package split ([603cfb9a](https://github.com/AgiFlow/doompi/commit/603cfb9a))
- **root:** repair folder migration regressions ([9f8a1f22](https://github.com/AgiFlow/doompi/commit/9f8a1f22))
- **doompi-web:** remove dormant sessions directly ([d1ae0381](https://github.com/AgiFlow/doompi/commit/d1ae0381))

### 🧱 Updated Dependencies

- Updated @agimon-ai/doompi-telemetry to 0.0.1-alpha.70
- Updated @agimon-ai/doompi-web-security to 0.0.1-alpha.33
- Updated @agimon-ai/vibe-lint-plugin-doom-core to 0.0.1-alpha.4

### ❤️ Thank You

- Vuong Ngo
- vuongngo

## 0.0.1-alpha.72 (2026-09-15)

### 🚀 Features

- surface the effective system prompt in the context panel ([a594b6d2](https://github.com/AgiFlow/doompi/commit/a594b6d2))
- **doompi-core:** complete folder paths in session file suggestions ([7f991cc2](https://github.com/AgiFlow/doompi/commit/7f991cc2))
- **doompi-core:** expose Pi extension tool prompt guidance ([b3e75763](https://github.com/AgiFlow/doompi/commit/b3e75763))
- **doompi-web:** restore cockpit sessions after a server restart ([42d3e441](https://github.com/AgiFlow/doompi/commit/42d3e441))

### 🩹 Fixes

- **root:** format two test files and cover reviveSession ([0b74c548](https://github.com/AgiFlow/doompi/commit/0b74c548))
- **doompi-core:** preload Pi extensions through the headless host provider ([cea127d8](https://github.com/AgiFlow/doompi/commit/cea127d8))
- **core:** filter file completion through .gitignore and .doomignore ([30dfb4cc](https://github.com/AgiFlow/doompi/commit/30dfb4cc))
- mount headless session facets and restore state ([17e4e229](https://github.com/AgiFlow/doompi/commit/17e4e229))
- align workspace REST and WebSocket routes ([78f77c59](https://github.com/AgiFlow/doompi/commit/78f77c59))
- preserve runner output and align global plugin routes ([9de6fe9c](https://github.com/AgiFlow/doompi/commit/9de6fe9c))
- preserve web model state and complete stalled runner commands ([1ac5a47c](https://github.com/AgiFlow/doompi/commit/1ac5a47c))
- **doompi-core,doompi-voice:** silence teardown selection notices and coalesce catalog refreshes ([8de90596](https://github.com/AgiFlow/doompi/commit/8de90596))
- **doompi-core:** reconcile headless contributions only after the first selection ([482555a6](https://github.com/AgiFlow/doompi/commit/482555a6))
- **doompi-core:** scope hub channels and fix child model spawns ([cb6cec79](https://github.com/AgiFlow/doompi/commit/cb6cec79))

### 🧱 Updated Dependencies

- Updated @agimon-ai/doompi-telemetry to 0.0.1-alpha.69
- Updated @agimon-ai/doompi-web-security to 0.0.1-alpha.32
- Updated @agimon-ai/vibe-lint-plugin-doom-core to 0.0.1-alpha.3

### ❤️ Thank You

- Vuong Ngo
- vuongngo

## 0.0.1-alpha.71 (2026-09-14)

### 🩹 Fixes

- **doompi-core:** load bundle asset policy from a node-safe entry ([f7f5e09e](https://github.com/AgiFlow/doompi/commit/f7f5e09e))

### ❤️ Thank You

- Vuong Ngo

## 0.0.1-alpha.70 (2026-09-13)

### 🚀 Features

- **doompi-team:** integrate session API ([71f04498](https://github.com/AgiFlow/doompi/commit/71f04498))
- add API contracts and expand voice runtime ([99940bd1](https://github.com/AgiFlow/doompi/commit/99940bd1))
- refactor DoomPi kernel and server packages ([59fca629](https://github.com/AgiFlow/doompi/commit/59fca629))

### 🩹 Fixes

- support concurrent cockpit session clients ([524461b1](https://github.com/AgiFlow/doompi/commit/524461b1))
- guard session client attachment lifecycle ([2ab9ea20](https://github.com/AgiFlow/doompi/commit/2ab9ea20))
- **doompi-web:** repair browser e2e runtime regressions ([ccdfaa60](https://github.com/AgiFlow/doompi/commit/ccdfaa60))
- **doompi-web:** preserve streamed session metadata ([36a15fd0](https://github.com/AgiFlow/doompi/commit/36a15fd0))
- stabilize CI runtime checks ([2590e66d](https://github.com/AgiFlow/doompi/commit/2590e66d))

### 🧱 Updated Dependencies

- Updated @agimon-ai/doompi-telemetry to 0.0.1-alpha.68
- Updated @agimon-ai/doompi-web-security to 0.0.1-alpha.31
- Updated @agimon-ai/vibe-lint-plugin-doom-core to 0.0.1-alpha.2

### ❤️ Thank You

- vuongngo