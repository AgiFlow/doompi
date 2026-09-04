# @agimon-ai/doompi-computer-use

Session-scoped semantic computer control through the DoomPi Desktop capability.

## Requirements

- Node.js 22.19.0 or newer
- DoomPi Desktop with Computer Use available
- `@earendil-works/pi-coding-agent` 0.85.0

## Install

```bash
pi install npm:@agimon-ai/doompi-computer-use
```

## Use

Open the **Computer Use** cockpit panel, refresh the Desktop targets, select an application window, and request activation. The request stays blocked until you confirm it in the panel. Only one session can hold a live Desktop run.

The `computer-use` session minor mode also exposes Activate and Stop actions. Activate requires the Desktop bundle id and window id. `/computer-use` reports the current state.

While active, the package exposes exactly two tools:

- `computer_state` observes the authorized window and returns a semantic snapshot.
- `computer_action` performs one semantic press, value change, or scroll against a current snapshot.

Both tools and their model guidance are removed when the session is dormant. The panel shows activation status, busy ownership, stop controls, and completed recording or trace metadata. Browser clients cannot call observation or action routes.

## Public API

```ts
import { activateComputerUseExtension, createComputerUseSessionClient } from '@agimon-ai/doompi-computer-use';
```

The session API entry is available at `@agimon-ai/doompi-computer-use/session-api`. Its agent and hub routes use separate host-issued context tokens. Grants remain opaque and session-bound inside the request broker.

## Development

```bash
pnpm fixcode
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT
