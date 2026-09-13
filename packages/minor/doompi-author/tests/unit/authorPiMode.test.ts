import { expect, it, vi } from 'vitest';

import { createAuthorPiMode } from '../../src/controllers/authorPiMode';
import type { AuthorCatalog } from '../../src/services/authorCatalog/type';

it('starts viewport polling only after plugin startup and aborts it during stop', async () => {
  let pollSignal: AbortSignal | undefined;
  const catalog: AuthorCatalog = {
    open: vi.fn(),
    execute: vi.fn(),
    describe: vi.fn<AuthorCatalog['describe']>((signal) => {
      pollSignal = signal;
      return new Promise(() => undefined);
    }),
  };
  const lifecycle = new AbortController();
  const runtime = createAuthorPiMode(catalog, lifecycle.signal);
  await runtime.mode.definition.handleAction('activate', {}, { signal: lifecycle.signal });
  expect(catalog.describe).not.toHaveBeenCalled();
  runtime.onStart();
  expect(catalog.describe).toHaveBeenCalledOnce();
  expect(runtime.isActive()).toBe(true);
  lifecycle.abort();
  runtime.onStop();
  expect(pollSignal?.aborted).toBe(true);
  expect(runtime.isActive()).toBe(false);
  expect(() => runtime.assertAvailable()).toThrow('disposed');
  runtime.onDispose();
});
