import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRequestReceipts } from '../../../../src/services/requestReceipts';

const request = {
  namespace: 'voice.admission',
  activationId: 'activation-1',
  requestId: 'provider-request-1',
  fingerprint: 'a'.repeat(64),
  destination: 'host-a/session-a/incarnation-1',
  transactionId: 'route-generation-1',
};

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-voice-receipts-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('native request receipt history', () => {
  it('atomically reserves an exact provider ID and persists its tombstone across reopen', () =>
    withDirectory(async (root) => {
      const directory = path.join(root, 'metadata');
      const first = createRequestReceipts({ directory });
      try {
        const results = await Promise.all(Array.from({ length: 16 }, () => first.receipts.reserve(request)));
        const fresh = results.filter((result) => result.kind === 'reserved');
        expect(fresh).toHaveLength(1);
        expect(results.filter((result) => result.kind === 'existing')).toHaveLength(15);
        const token = fresh[0]?.kind === 'reserved' ? fresh[0].token : undefined;
        expect(token).toBeDefined();
        await expect(first.receipts.finish({ ...request, token: 'wrong-token', outcome: 'admitted' })).rejects.toThrow(
          'token does not match',
        );
        const admitted = await first.receipts.finish({ ...request, token: token!, outcome: 'admitted' });
        expect(admitted.outcome).toBe('admitted');
        await expect(first.receipts.finish({ ...request, token: token!, outcome: 'admitted' })).resolves.toEqual(
          admitted,
        );
        await expect(first.receipts.finish({ ...request, token: token!, outcome: 'rejected' })).rejects.toThrow(
          'already been finished',
        );
        expect(await first.receipts.reserve({ ...request, fingerprint: 'b'.repeat(64) })).toMatchObject({
          kind: 'conflict',
        });
        const file = path.join(directory, 'request_receipts.sqlite');
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      } finally {
        await first.close();
      }

      const reopened = createRequestReceipts({ directory });
      try {
        expect(await reopened.receipts.lookup(request)).toMatchObject({ outcome: 'admitted' });
        expect(await reopened.receipts.reserve(request)).toMatchObject({ kind: 'existing' });
        expect(await reopened.receipts.reserve({ ...request, requestId: 'provider-request-2' })).toMatchObject({
          kind: 'reserved',
        });
      } finally {
        await reopened.close();
      }
    }));

  it('does not equate a fresh wire event or a colliding delimiter with a new provider request', () =>
    withDirectory(async (directory) => {
      const owner = createRequestReceipts({ directory });
      try {
        for (let index = 0; index < 150; index += 1) {
          const keyed = { ...request, requestId: `provider-${String(index)}` };
          const result = await owner.receipts.reserve(keyed);
          expect(result.kind).toBe('reserved');
          if (result.kind === 'reserved')
            await owner.receipts.finish({ ...keyed, token: result.token, outcome: 'admitted' });
        }
        expect(await owner.receipts.reserve({ ...request, requestId: 'provider-1' })).toMatchObject({
          kind: 'existing',
        });
        const first = { ...request, activationId: 'a/b', requestId: 'c' };
        const second = { ...request, activationId: 'a', requestId: 'b/c' };
        expect((await owner.receipts.reserve(first)).kind).toBe('reserved');
        expect((await owner.receipts.reserve(second)).kind).toBe('reserved');
      } finally {
        await owner.close();
      }
    }));

  it('keeps an unfinished or uncertain reservation non-executable after reopening', () =>
    withDirectory(async (directory) => {
      const first = createRequestReceipts({ directory });
      try {
        expect((await first.receipts.reserve(request)).kind).toBe('reserved');
      } finally {
        await first.close();
      }
      const second = createRequestReceipts({ directory });
      try {
        expect(await second.receipts.reserve(request)).toMatchObject({
          kind: 'existing',
          receipt: { outcome: 'reserved' },
        });
        const newRequest = { ...request, requestId: 'provider-uncertain' };
        const fresh = await second.receipts.reserve(newRequest);
        if (fresh.kind !== 'reserved') throw new Error('Expected a fresh test reservation.');
        await second.receipts.finish({ ...newRequest, token: fresh.token, outcome: 'uncertain' });
        expect(await second.receipts.reserve(newRequest)).toMatchObject({
          kind: 'existing',
          receipt: { outcome: 'uncertain' },
        });
      } finally {
        await second.close();
      }
    }));

  it('fails closed when it cannot persist, and rejects calls after shutdown', () =>
    withDirectory(async (root) => {
      const blocked = path.join(root, 'file-instead-of-directory');
      await fs.writeFile(blocked, 'not a directory');
      const owner = createRequestReceipts({ directory: blocked });
      await expect(owner.receipts.reserve(request)).rejects.toThrow();
      await owner.close();
      await expect(owner.receipts.lookup(request)).rejects.toThrow('closed');
    }));
});
