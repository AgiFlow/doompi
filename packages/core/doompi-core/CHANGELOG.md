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