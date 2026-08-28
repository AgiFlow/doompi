# @agimon-ai/doompi-web-security

Shared security primitives for the DoomPi web cockpit: the sealed-channel envelope, its `node:crypto`
and WebCrypto halves, and the signed bundle manifest.

This package holds no policy and starts nothing. It exists because three different programs need to
agree byte for byte on the same crypto: the cockpit hub (Node), the cockpit page (browser), and every
web plugin bundled into that page.

## Why it is a package

A plugin in another package cannot import from a client application, and the sealed transport is a
module singleton whose nonce counters every caller must share. A second copy would start counting at
zero and the receiver would reject everything it sent as a replay. One package, deduped in the
bundle, is what makes that impossible.

## Subpaths

| Import                                   | Runs where | What it carries                                                                                          |
| ---------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `@agimon-ai/doompi-web-security`         | both       | The envelope contract, the bundle manifest shape, the canonical serialization both sides sign and verify |
| `@agimon-ai/doompi-web-security/browser` | the page   | The WebCrypto channel and `sealedTransport`, the shared instance plugins use                             |
| `@agimon-ai/doompi-web-security/node`    | the hub    | The `node:crypto` channel, the host handshake, and the bundle signer                                     |

## The sealed channel

A hosted tunnel terminates TLS at its provider's edge, so without application sealing everything the
cockpit carries is plaintext to them. Sealing the payload underneath their TLS leaves them a relay that
sees timing and sizes but not content.

The QR pairing path anchors key exchange out of band. The host's ephemeral P-256 public key is printed on
the screen the user is holding, so the relay cannot substitute its own. A returning device instead receives
the current public key after proving a passkey. That path depends on the trusted code-delivery edge described
above, and the key itself is public rather than secret.

Three properties worth knowing, because getting any of them wrong is silent:

- **Separate keys per direction.** Derived with different HKDF info strings, so a message the server
  sent can never be replayed back at it as though the client had sent it.
- **Nonces are a random per-channel prefix plus a monotonic counter**, never random per message. A
  repeated nonce under one AES-GCM key leaks the XOR of two plaintexts and the authentication subkey;
  96 bits is small enough that random nonces collide at a rate worth caring about.
- **Both directions are serialized.** Sealing advances the counter and opening demands it strictly
  increase, so overlapping asynchronous calls are a correctness bug, not a race worth tolerating.
  `createSerialQueue` is what prevents a burst of socket sends from reordering into a self-inflicted
  replay.

Every failure names itself. A decryption failure otherwise shows up as a blank page with nothing to
go on.

## The signed bundle-manifest primitive

The signer can support a separately distributed verifier whose bootstrap and public key are already
trusted. It hashes every asset and signs a canonical manifest with ECDSA P-256.

It is not a self-protection mechanism for a browser SPA. A server or TLS edge that can replace the page
can also remove an in-page verifier or replace the key it trusts. DoomPi's Cloudflare transport treats
Cloudflare as a trusted code-delivery boundary, so the cockpit does not use this primitive to claim
protection from a malicious edge.

`canonicalManifest` is hand-rolled rather than `JSON.stringify` of the whole object, because a signature
is only worth anything if signer and verifier agree byte for byte, and key order in a JSON object is an
implementation detail.

## Public API

```ts
import { canonicalManifest, describeSealedFailure, isSealedEnvelope } from '@agimon-ai/doompi-web-security';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { createBundleSigner, createHostHandshake } from '@agimon-ai/doompi-web-security/node';
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

The round-trip test is the one that matters: it seals with `node:crypto` and opens with real
WebCrypto, so the two implementations cannot drift apart without a failure.

Maintained by [Agimon](https://agimon.ai/about).
