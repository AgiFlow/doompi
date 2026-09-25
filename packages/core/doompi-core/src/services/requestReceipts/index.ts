import { randomUUID } from 'node:crypto';

import type { Session } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { setValue, value } from '@earendil-works/pi-agent-core/harness/session';

import type {
  DoomRequestReceipt,
  DoomRequestReceiptKey,
  DoomRequestReceiptReservation,
  DoomRequestReceipts,
} from '../../schemas/packageApi';
import { createHistoryOwnership } from '../historyOwnership';
import { openSqliteSessionStorage } from '../sqliteSessionStorage';

const RECEIPTS_SESSION_ID = 'request_receipts';
const RECEIPTS_NAMESPACE = 'doompi.request-receipts';
const FINGERPRINT = /^[a-f0-9]{64}$/u;
const NAMESPACE = /^[a-z][a-z0-9.-]*$/u;

type TerminalOutcome = Exclude<DoomRequestReceipt['outcome'], 'reserved'>;
interface StoredReceipt {
  version: 1;
  receipt: DoomRequestReceipt;
  token: string;
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function address(key: DoomRequestReceiptKey): ReturnType<typeof value<StoredReceipt>> {
  if (
    !bounded(key.namespace, 64) ||
    !NAMESPACE.test(key.namespace) ||
    !bounded(key.activationId, 256) ||
    !bounded(key.requestId, 256)
  )
    throw new Error('Invalid request receipt address.');
  // JSON tuple encoding retains exact arbitrary provider IDs, including separators.
  return value<StoredReceipt>(RECEIPTS_NAMESPACE, JSON.stringify([key.namespace, key.activationId, key.requestId]));
}

function storedReceipt(input: unknown, key: DoomRequestReceiptKey): StoredReceipt {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('Request receipt storage is corrupt.');
  const stored = input as Partial<StoredReceipt>;
  const receipt = stored.receipt;
  if (
    stored.version !== 1 ||
    !bounded(stored.token, 128) ||
    typeof receipt !== 'object' ||
    receipt === null ||
    receipt.namespace !== key.namespace ||
    receipt.activationId !== key.activationId ||
    receipt.requestId !== key.requestId ||
    !bounded(receipt.destination, 512) ||
    !bounded(receipt.transactionId, 256) ||
    !FINGERPRINT.test(receipt.fingerprint) ||
    !['reserved', 'admitted', 'rejected', 'uncertain'].includes(receipt.outcome)
  )
    throw new Error('Request receipt storage is corrupt.');
  return stored as StoredReceipt;
}

/** One native SQLite metadata history, independent of any selected agent session. */
export function createRequestReceipts(options: { directory: string }): {
  receipts: DoomRequestReceipts;
  close(): Promise<void>;
} {
  const ownership = createHistoryOwnership({ sourceFormat: 'sqlite' });
  let opened: ReturnType<typeof openSqliteSessionStorage> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();

  const session = async (): Promise<Session> => {
    if (closed) throw new Error('Request receipt storage is closed.');
    opened ??= openSqliteSessionStorage(
      { sessionsRoot: options.directory, sessionId: RECEIPTS_SESSION_ID, historyOwnership: ownership },
      BACKGROUND_CONTEXT,
    );
    return (await opened).session;
  };
  const operate = <T>(callback: (session: Session) => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('Request receipt storage is closed.'));
    const operation = session().then(callback);
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  };

  const receipts: DoomRequestReceipts = {
    reserve(request: DoomRequestReceiptReservation) {
      const receiptAddress = address(request);
      if (
        !FINGERPRINT.test(request.fingerprint) ||
        !bounded(request.destination, 512) ||
        !bounded(request.transactionId, 256)
      )
        throw new Error('Invalid request receipt reservation.');
      return operate((storage) =>
        storage.mutate(async (mutator) => {
          const existing = await mutator.getValue(receiptAddress, BACKGROUND_CONTEXT);
          if (existing !== undefined) {
            const prior = storedReceipt(existing.value, request).receipt;
            return prior.fingerprint === request.fingerprint &&
              prior.destination === request.destination &&
              prior.transactionId === request.transactionId
              ? { kind: 'existing' as const, receipt: prior }
              : { kind: 'conflict' as const, receipt: prior };
          }
          const token = randomUUID();
          const receipt: DoomRequestReceipt = {
            namespace: request.namespace,
            activationId: request.activationId,
            requestId: request.requestId,
            fingerprint: request.fingerprint,
            destination: request.destination,
            transactionId: request.transactionId,
            outcome: 'reserved',
          };
          await mutator.commit([setValue(receiptAddress, { version: 1, receipt, token })], BACKGROUND_CONTEXT);
          return { kind: 'reserved' as const, token };
        }, BACKGROUND_CONTEXT),
      );
    },
    lookup(key: DoomRequestReceiptKey) {
      const receiptAddress = address(key);
      return operate(async (storage) => {
        const existing = await storage.getValue(receiptAddress, BACKGROUND_CONTEXT);
        return existing === undefined ? undefined : storedReceipt(existing.value, key).receipt;
      });
    },
    finish(request: DoomRequestReceiptKey & { token: string; outcome: TerminalOutcome }) {
      const receiptAddress = address(request);
      if (!bounded(request.token, 128) || !['admitted', 'rejected', 'uncertain'].includes(request.outcome))
        throw new Error('Invalid request receipt finish.');
      return operate((storage) =>
        storage.mutate(async (mutator) => {
          const existing = await mutator.getValue(receiptAddress, BACKGROUND_CONTEXT);
          if (existing === undefined) throw new Error('Request receipt reservation does not exist.');
          const prior = storedReceipt(existing.value, request);
          if (prior.token !== request.token) throw new Error('Request receipt token does not match.');
          if (prior.receipt.outcome === request.outcome) return prior.receipt;
          if (prior.receipt.outcome !== 'reserved') throw new Error('Request receipt has already been finished.');
          const receipt: DoomRequestReceipt = { ...prior.receipt, outcome: request.outcome };
          await mutator.commit([setValue(receiptAddress, { ...prior, receipt })], BACKGROUND_CONTEXT);
          return receipt;
        }, BACKGROUND_CONTEXT),
      );
    },
  };

  return {
    receipts,
    close() {
      if (closing !== undefined) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled(operations);
        if (opened === undefined) return;
        const storage = await opened.catch(() => undefined);
        if (storage === undefined) return;
        const errors: unknown[] = [];
        try {
          await storage.session.close(BACKGROUND_CONTEXT);
        } catch (error) {
          errors.push(error);
        }
        try {
          await storage.repository.close(BACKGROUND_CONTEXT);
        } catch (error) {
          errors.push(error);
        }
        try {
          await storage.historyLease.release();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) throw new AggregateError(errors, 'Request receipt storage failed to close.');
      })();
      return closing;
    },
  };
}
