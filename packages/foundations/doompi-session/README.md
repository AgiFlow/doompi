# @agimon-ai/doompi-session

Shared session coordination services for DoomPi.

The foundation owns the session-scoped background-work coordinator used by optional execution packages. It also provides SQLite-backed delivery with host-bound sender identities, durable inbox and outbox state, acknowledgements, keyed duplicate suppression, and prompt admission that wakes idle recipients. Interrupted admission is marked for recovery and is never replayed automatically.

Its public services also include:

- An in-memory, permission-filtered presence directory with qualified references, separate reachability, runtime, activity, and Voice facts, incarnation and sequence tracking, expiry, and snapshot recovery after sequence gaps.
- A SQLite communication-group registry with one owner authority, explicit qualified members, enrollment policy, revision conflicts, and current-membership authorization.
- An agent-facing intercom service for `discover`, attributed direct `send`, `messages`, and correlated `report` operations. Compositions acquire this service explicitly. Group membership grants only discovery and messaging, never session controls or Voice ownership.

Session delivery rechecks current authority before each initial send and queued retry. Removing a member therefore blocks later publication while preserving already accepted delivery evidence.

## Paired hosts

A paired host is configured privately in `~/.pi/.doom/session/peers.json`. The file must be owner-only (`0600`). Each peer needs an HTTPS tunnel URL, a shared secret of at least 32 characters, and explicit operation-specific session allowlists. Pairing alone grants no Session or Voice access.

```json
{
  "version": 1,
  "hostId": "home-host",
  "peers": [
    {
      "hostId": "work-host",
      "url": "https://work.example.net/",
      "secret": "replace-with-a-private-32-character-minimum-secret",
      "allowedSessionIds": ["approved-message-session-id"],
      "allowedVoiceSessionIds": ["approved-voice-session-id"]
    }
  ]
}
```

Use `peer/<host-id>/<session-id>` as a qualified target. `allowedSessionIds` grants durable messages and acknowledgements. `allowedVoiceSessionIds` separately grants bounded Voice client-media relay operations. Neither grant exposes owner, `/host/*`, or `/hub/*` routes.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```
