import { DatabaseSync } from 'node:sqlite';

import type { Context } from '@deepseek-ai/cordis';

import {
  DOOM_SESSION_DELIVERY_SERVICE,
  type DoomSessionDeliveryInboxState,
  type DoomSessionDeliveryMetadata,
  type DoomSessionDeliveryMode,
  type DoomSessionDeliveryRequest,
  type DoomSessionDeliveryService,
  type DoomSessionInboxEntry,
  type DoomSessionInboxQuery,
  type DoomSessionOutboxEntry,
  type SessionDeliveryServiceOptions,
} from './type';

const DELIVERY_EVENT = 'doom/session-delivery/envelope';
const ACK_EVENT = 'doom/session-delivery/ack';
const DEFAULT_DELIVERY: DoomSessionDeliveryMode = 'prompt';
const INBOX_STATES = new Set<DoomSessionDeliveryInboxState>(['accepted', 'admitting', 'admitted', 'recovery_required']);

interface DeliveryEnvelope {
  readonly deliveryId: string;
  readonly kind: string;
  readonly prompt: string;
  readonly delivery: DoomSessionDeliveryMode;
  readonly metadata: DoomSessionDeliveryMetadata;
}

interface DeliveryAck {
  readonly deliveryId: string;
  readonly state: DoomSessionDeliveryInboxState;
}

interface InboxRow {
  delivery_id: string;
  sender_key: string;
  recipient_key: string;
  kind: string;
  prompt: string;
  delivery_mode: DoomSessionDeliveryMode;
  metadata_json: string;
  state: DoomSessionDeliveryInboxState;
  consumed_at: number | null;
}

interface OutboxRow {
  delivery_id: string;
  recipient_key: string;
  kind: string;
  prompt: string;
  delivery_mode: DoomSessionDeliveryMode;
  metadata_json: string;
  state: 'queued' | 'acknowledged';
  recipient_state: DoomSessionDeliveryInboxState | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is DoomSessionDeliveryMode {
  return value === 'prompt' || value === 'steer' || value === 'followUp';
}

function metadataOf(value: unknown): DoomSessionDeliveryMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined;
    metadata[key] = item;
  }
  return metadata;
}

function envelopeOf(value: unknown): DeliveryEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const metadata = metadataOf(value.metadata);
  if (
    typeof value.deliveryId !== 'string' ||
    !value.deliveryId ||
    typeof value.kind !== 'string' ||
    !value.kind ||
    typeof value.prompt !== 'string' ||
    !isMode(value.delivery) ||
    metadata === undefined
  ) {
    return undefined;
  }
  return {
    deliveryId: value.deliveryId,
    kind: value.kind,
    prompt: value.prompt,
    delivery: value.delivery,
    metadata,
  };
}

function ackOf(value: unknown): DeliveryAck | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.deliveryId !== 'string' ||
    typeof value.state !== 'string' ||
    !INBOX_STATES.has(value.state as DoomSessionDeliveryInboxState)
  ) {
    return undefined;
  }
  return value as unknown as DeliveryAck;
}

function normalizedMetadata(metadata: DoomSessionDeliveryMetadata | undefined): DoomSessionDeliveryMetadata {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) normalized[key] = value;
  }
  return normalized;
}

function matchesMetadata(entry: DoomSessionDeliveryMetadata, query: DoomSessionDeliveryMetadata | undefined): boolean {
  return Object.entries(query ?? {}).every(([key, value]) => value === undefined || entry[key] === value);
}

function sameMetadata(left: DoomSessionDeliveryMetadata, right: DoomSessionDeliveryMetadata): boolean {
  return matchesMetadata(left, right) && matchesMetadata(right, left);
}

/** Opens and starts one durable delivery endpoint. */
export function createSessionDeliveryService(options: SessionDeliveryServiceOptions): DoomSessionDeliveryService {
  if (!options.recipientKey.trim() || options.recipientKey !== options.recipientKey.trim()) {
    throw new TypeError('Session delivery requires a trimmed, non-empty recipient key.');
  }
  const database = new DatabaseSync(options.databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS session_delivery_outbox (
      delivery_id TEXT PRIMARY KEY,
      recipient_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      state TEXT NOT NULL,
      recipient_state TEXT,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_delivery_inbox (
      delivery_id TEXT PRIMARY KEY,
      sender_key TEXT NOT NULL,
      recipient_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
  `);
  database
    .prepare("UPDATE session_delivery_inbox SET state = 'recovery_required', updated_at = ? WHERE state = 'admitting'")
    .run(Date.now());

  let closed = false;
  const scheduled = new Set<string>();
  let admissionQueue = Promise.resolve();

  const publishAck = (deliveryId: string, senderKey: string, state: DoomSessionDeliveryInboxState): void => {
    options.communication.publish(senderKey, ACK_EVENT, { deliveryId, state } satisfies DeliveryAck);
  };

  const readInboxRow = (deliveryId: string): InboxRow | undefined =>
    database.prepare('SELECT * FROM session_delivery_inbox WHERE delivery_id = ?').get(deliveryId) as
      | InboxRow
      | undefined;

  const scheduleAdmission = (deliveryId: string): void => {
    if (closed || scheduled.has(deliveryId)) return;
    scheduled.add(deliveryId);
    admissionQueue = admissionQueue
      .then(async () => {
        try {
          if (closed) return;
          const row = readInboxRow(deliveryId);
          if (!row || row.state !== 'accepted') return;
          database
            .prepare("UPDATE session_delivery_inbox SET state = 'admitting', updated_at = ? WHERE delivery_id = ?")
            .run(Date.now(), deliveryId);
          publishAck(deliveryId, row.sender_key, 'admitting');
          try {
            await options.admitPrompt(row.prompt, row.delivery_mode);
          } catch {
            database
              .prepare(
                "UPDATE session_delivery_inbox SET state = 'recovery_required', updated_at = ? WHERE delivery_id = ?",
              )
              .run(Date.now(), deliveryId);
            publishAck(deliveryId, row.sender_key, 'recovery_required');
            return;
          }
          database
            .prepare("UPDATE session_delivery_inbox SET state = 'admitted', updated_at = ? WHERE delivery_id = ?")
            .run(Date.now(), deliveryId);
          publishAck(deliveryId, row.sender_key, 'admitted');
        } finally {
          scheduled.delete(deliveryId);
        }
      })
      .catch(() => {
        scheduled.delete(deliveryId);
        try {
          const row = readInboxRow(deliveryId);
          if (row?.state !== 'admitting') return;
          database
            .prepare(
              "UPDATE session_delivery_inbox SET state = 'recovery_required', updated_at = ? WHERE delivery_id = ?",
            )
            .run(Date.now(), deliveryId);
          try {
            publishAck(deliveryId, row.sender_key, 'recovery_required');
          } catch {
            // The durable state is authoritative; readiness replay can request another acknowledgement.
          }
        } catch {
          // A database failure remains recoverable on restart when the schema can be opened again.
        }
      });
  };

  const receiveEnvelope = (senderKey: string, value: unknown): DoomSessionDeliveryInboxState | undefined => {
    if (closed) return undefined;
    const envelope = envelopeOf(value);
    if (!envelope || !options.authorizePeer(senderKey)) return undefined;
    database
      .prepare(
        `INSERT OR IGNORE INTO session_delivery_inbox
         (delivery_id, sender_key, recipient_key, kind, prompt, delivery_mode, metadata_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      )
      .run(
        envelope.deliveryId,
        senderKey,
        options.recipientKey,
        envelope.kind,
        envelope.prompt,
        envelope.delivery,
        JSON.stringify(envelope.metadata),
        Date.now(),
        Date.now(),
      );
    const current = readInboxRow(envelope.deliveryId);
    if (!current) return undefined;
    const sameEnvelope =
      current.sender_key === senderKey &&
      current.recipient_key === options.recipientKey &&
      current.kind === envelope.kind &&
      current.prompt === envelope.prompt &&
      current.delivery_mode === envelope.delivery &&
      sameMetadata(JSON.parse(current.metadata_json) as DoomSessionDeliveryMetadata, envelope.metadata);
    if (!sameEnvelope) return undefined;
    publishAck(envelope.deliveryId, current.sender_key, current.state);
    if (current.state === 'accepted') scheduleAdmission(envelope.deliveryId);
    return current.state;
  };

  const receiveAck = (recipientKey: string, value: unknown): void => {
    if (closed || !options.authorizePeer(recipientKey)) return;
    const ack = ackOf(value);
    if (!ack) return;
    database
      .prepare(
        `UPDATE session_delivery_outbox
         SET state = 'acknowledged', recipient_state = ?, acknowledged_at = ?
         WHERE delivery_id = ? AND recipient_key = ?`,
      )
      .run(ack.state, Date.now(), ack.deliveryId, recipientKey);
  };

  const publishOutbox = (deliveryId: string): void => {
    const row = database
      .prepare("SELECT * FROM session_delivery_outbox WHERE delivery_id = ? AND state = 'queued'")
      .get(deliveryId) as OutboxRow | undefined;
    if (!row) return;
    options.communication.publish(row.recipient_key, DELIVERY_EVENT, {
      deliveryId: row.delivery_id,
      kind: row.kind,
      prompt: row.prompt,
      delivery: row.delivery_mode,
      metadata: JSON.parse(row.metadata_json) as DoomSessionDeliveryMetadata,
    } satisfies DeliveryEnvelope);
  };

  const publishQueued = (recipientKey: string): void => {
    for (const row of database
      .prepare("SELECT delivery_id FROM session_delivery_outbox WHERE recipient_key = ? AND state = 'queued'")
      .all(recipientKey) as { delivery_id: string }[]) {
      publishOutbox(row.delivery_id);
    }
  };
  const publishAllQueued = (): void => {
    for (const row of database
      .prepare("SELECT delivery_id FROM session_delivery_outbox WHERE state = 'queued'")
      .all() as { delivery_id: string }[]) {
      publishOutbox(row.delivery_id);
    }
  };
  const releaseEnvelope = options.communication.subscribe(DELIVERY_EVENT, receiveEnvelope);
  const releaseAck = options.communication.subscribe(ACK_EVENT, receiveAck);
  const releaseReady = options.communication.onPeerReady(publishQueued);

  for (const row of database
    .prepare("SELECT delivery_id, sender_key FROM session_delivery_inbox WHERE state = 'recovery_required'")
    .all() as { delivery_id: string; sender_key: string }[]) {
    publishAck(row.delivery_id, row.sender_key, 'recovery_required');
  }
  for (const row of database
    .prepare("SELECT delivery_id FROM session_delivery_inbox WHERE state = 'accepted'")
    .all() as {
    delivery_id: string;
  }[]) {
    scheduleAdmission(row.delivery_id);
  }
  publishAllQueued();
  // A publish only means the transport accepted the envelope. Repeat stable delivery
  // IDs until the durable acknowledgement arrives, including after a tunnel restart.
  const retryTimer = setInterval(publishAllQueued, 1_000);
  retryTimer.unref();

  return Object.freeze({
    recipientKey: options.recipientKey,
    async deliver(request: DoomSessionDeliveryRequest): Promise<{ deliveryId: string }> {
      if (closed) throw new Error('Session delivery service is closed.');
      const deliveryId = request.deliveryId ?? crypto.randomUUID();
      const mode = request.delivery ?? DEFAULT_DELIVERY;
      if (!deliveryId.trim() || !request.recipientKey.trim() || !request.kind.trim() || !isMode(mode)) {
        throw new TypeError('Delivery id, recipient key, kind, and mode must be valid.');
      }
      if (!options.authorizePeer(request.recipientKey)) {
        throw new Error(`Session '${request.recipientKey}' is not an authorized communication peer.`);
      }
      const metadata = normalizedMetadata(request.metadata);
      database
        .prepare(
          `INSERT OR IGNORE INTO session_delivery_outbox
           (delivery_id, recipient_key, kind, prompt, delivery_mode, metadata_json, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          deliveryId,
          request.recipientKey,
          request.kind,
          request.prompt,
          mode,
          JSON.stringify(metadata),
          Date.now(),
        );
      const current = database
        .prepare('SELECT * FROM session_delivery_outbox WHERE delivery_id = ?')
        .get(deliveryId) as OutboxRow | undefined;
      if (
        !current ||
        current.recipient_key !== request.recipientKey ||
        current.kind !== request.kind ||
        current.prompt !== request.prompt ||
        current.delivery_mode !== mode ||
        !sameMetadata(JSON.parse(current.metadata_json) as DoomSessionDeliveryMetadata, metadata)
      ) {
        throw new TypeError(`Delivery id '${deliveryId}' is already bound to another envelope.`);
      }
      publishOutbox(deliveryId);
      return { deliveryId };
    },
    async waitForAdmission(deliveryId: string, timeoutMs = 5_000): Promise<DoomSessionDeliveryInboxState | undefined> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      let state: DoomSessionDeliveryInboxState | undefined;
      do {
        const row = database
          .prepare('SELECT recipient_state FROM session_delivery_outbox WHERE delivery_id = ?')
          .get(deliveryId) as { recipient_state: DoomSessionDeliveryInboxState | null } | undefined;
        state = row?.recipient_state ?? undefined;
        if (state === 'admitted' || state === 'recovery_required') return state;
        if (Date.now() >= deadline) return state;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - Date.now())));
      } while (!closed);
      return state;
    },
    receive(senderKey: string, kind: string, payload: unknown) {
      if (kind === DELIVERY_EVENT) return receiveEnvelope(senderKey, payload);
      if (kind === ACK_EVENT) {
        receiveAck(senderKey, payload);
        return 'accepted';
      }
      return undefined;
    },
    inbox(query: DoomSessionInboxQuery = {}): readonly DoomSessionInboxEntry[] {
      const rows = database
        .prepare('SELECT * FROM session_delivery_inbox ORDER BY created_at, delivery_id')
        .all() as unknown as InboxRow[];
      return rows
        .map((row): DoomSessionInboxEntry => {
          const metadata = JSON.parse(row.metadata_json) as DoomSessionDeliveryMetadata;
          return {
            deliveryId: row.delivery_id,
            senderKey: row.sender_key,
            recipientKey: row.recipient_key,
            kind: row.kind,
            prompt: row.prompt,
            delivery: row.delivery_mode,
            metadata,
            state: row.state,
            consumed: row.consumed_at !== null,
          };
        })
        .filter(
          (entry) =>
            (query.kind === undefined || entry.kind === query.kind) &&
            (query.state === undefined || entry.state === query.state) &&
            (query.consumed === undefined || entry.consumed === query.consumed) &&
            matchesMetadata(entry.metadata, query.metadata),
        );
    },
    consume(deliveryId: string): boolean {
      const result = database
        .prepare(
          "UPDATE session_delivery_inbox SET consumed_at = ? WHERE delivery_id = ? AND state IN ('admitted', 'recovery_required') AND consumed_at IS NULL",
        )
        .run(Date.now(), deliveryId);
      return result.changes === 1;
    },
    outbox(deliveryId: string): DoomSessionOutboxEntry | undefined {
      const row = database
        .prepare(
          'SELECT delivery_id, recipient_key, kind, state, recipient_state FROM session_delivery_outbox WHERE delivery_id = ?',
        )
        .get(deliveryId) as OutboxRow | undefined;
      if (!row) return undefined;
      return {
        deliveryId: row.delivery_id,
        recipientKey: row.recipient_key,
        kind: row.kind,
        state: row.state,
        ...(row.recipient_state === null ? {} : { recipientState: row.recipient_state }),
      };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(retryTimer);
      releaseEnvelope();
      releaseAck();
      releaseReady();
      try {
        await admissionQueue;
      } finally {
        database.close();
      }
    },
  });
}

/** Installs a provider-owned endpoint in the current Cordis context. */
export function provideSessionDeliveryService(
  context: Context,
  options: SessionDeliveryServiceOptions,
): () => Promise<void> {
  const service = createSessionDeliveryService(options);
  const unprovide = context.provide(DOOM_SESSION_DELIVERY_SERVICE, service);
  return async () => {
    unprovide();
    await service.close();
  };
}

export type {
  DoomSessionDeliveryInboxState,
  DoomSessionDeliveryMetadata,
  DoomSessionDeliveryMode,
  DoomSessionDeliveryRequest,
  DoomSessionDeliveryService,
  DoomSessionInboxEntry,
  DoomSessionInboxQuery,
  DoomSessionOutboxEntry,
  SessionDeliveryServiceOptions,
} from './type';
export { DOOM_SESSION_DELIVERY_SERVICE, readDoomSessionDelivery } from './type';
