# @agimon-ai/doompi-git

Git worktree sessions for DoomPi: spawn an isolated worktree with its own session and manage it from the parent

This package is a composable [DoomPi](https://www.npmjs.com/package/@agimon-ai/doompi) subsystem. Use it with the distribution or install it independently in [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

## Requirements

- Node.js 22.19.0 or newer
- `@earendil-works/pi-coding-agent` 0.85.0

## Install

```bash
pi install npm:@agimon-ai/doompi-git
```

The package declares its Pi extension entry, so Pi loads it after installation. DoomPi users can include the package through their normal profile and domain composition instead.

## Use

Run the registered command in Pi:

```text
/doom-git
```

Show git worktrees owned by this session

### New-session dialog

In the web cockpit, doompi-git replaces the new-session dialog for a git workspace. It offers three choices:

- **Existing branch**: a worktree session on a local branch, or on a remote-only branch (a local tracking branch is created). Branches already checked out elsewhere are disabled.
- **New branch**: a worktree session on a new branch from a base, preselected to the repository's default branch.
- **No branch**: a plain session in the workspace folder.

Worktree sessions opened here start at the top level of the session rail, with no parent. A workspace that is not a git checkout offers the plain session only. For remote devices, creating a worktree session needs the same passkey step-up as any new session.

## Package behavior

> Before publishing, replace this paragraph with one concrete, copy-pasteable example of the package-specific input, output, configuration, or workflow that is not already demonstrated by the generated command.

## Help

The published package includes `llms.txt` and the package-owned `src/prompts/doompi-use-git/SKILL.md`. When the DoomPi Help minor mode is active, the extension contributes `doompi-use-git` to its live Help catalog. The contribution follows Help provider replacement and is withdrawn when the extension shuts down.

Help remains optional. Loading the standalone Pi extension does not require DoomPi Help or any other DoomPi runtime service.

To add another package-owned Help prompt, use the `scaffold-doom-prompt` feature with a `doompi-author-*` or `doompi-use-*` name and a concise description. Then link the generated `SKILL.md` from `llms.txt` and register a matching descriptor through the optional `DOOM_HELP_SERVICE` injection in the Pi adapter. Keep prompts as published resources under `src/prompts`; do not export them or copy them into `dist`.

## Public API

```ts
import { DefaultGitExtensionService, activateGitExtension } from '@agimon-ai/doompi-git';
```

The Pi host entry is also available at:

```text
@agimon-ai/doompi-git/extensions/pi
```

The service layer is host-neutral. The Pi entrypoint owns only command registration and its runtime-scoped installation guard.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm exec vibe-lint check .
npm pack --dry-run
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT

Named Pi and server factories live in `src/extensions`. Controllers declare commands and APIs; services own worktree operations and filesystem persistence; tools return typed Pi declarations. Public services and types are exposed through flat `src/exports`. In composed DoomPi sessions, the fixed Session foundation durably admits `spawn_worktree.task`, parent messages, and child reports while waking the recipient. The prior in-memory inbox remains only as a standalone compatibility fallback.
