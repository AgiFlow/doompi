# @agimon-ai/doompi-session

Shared session coordination services for DoomPi.

The foundation owns the session-scoped background-work coordinator used by optional execution packages. It also provides SQLite-backed same-hub delivery with host-bound sender identities, durable inbox and outbox state, acknowledgements, keyed duplicate suppression, and prompt admission that wakes idle recipients. Interrupted admission is marked for recovery and is never replayed automatically. The durable ledger and delivery contract are transport-neutral so paired-host transport can be added without changing consumers.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```
