# @agimon-ai/doompi-session

Shared session coordination services for DoomPi.

The foundation owns the session-scoped background-work coordinator used by optional execution packages. It also provides SQLite-backed delivery with host-bound sender identities, durable inbox and outbox state, acknowledgements, keyed duplicate suppression, and prompt admission that wakes idle recipients. Interrupted admission is marked for recovery and is never replayed automatically.

## Paired hosts

A paired host is configured privately in `~/.pi/.doom/session/peers.json`. Each peer needs an HTTPS tunnel URL, a shared secret of at least 32 characters, and an explicit allowlist of local recipient session IDs. Pairing alone grants no Session access.

```json
{
  "version": 1,
  "hostId": "home-host",
  "peers": [
    {
      "hostId": "work-host",
      "url": "https://work.example.net/",
      "secret": "replace-with-a-private-32-character-minimum-secret",
      "allowedSessionIds": ["approved-local-session-id"]
    }
  ]
}
```

Use `peer/<host-id>/<session-id>` as the durable recipient key. Messages and acknowledgements are HMAC-authenticated and retried until the receiving durable inbox acknowledges them.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```
