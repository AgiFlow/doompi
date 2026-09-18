import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { downloadAsset } from './fetch-runner-binaries.mjs';

const cacheRoot = path.join(process.cwd(), '.nx-cache', 'runner-binaries');

function target(name) {
  return { repo: 'doompi/retry-test', tag: 'vtest', asset: `${name}-${process.pid}.tar.gz` };
}

function cachedPath(value) {
  return path.join(cacheRoot, `${value.tag}-${value.asset}`);
}

test('Runner asset downloads retry transient failures only', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('retries a socket failure', async (t) => {
    const value = target('transient');
    const cached = cachedPath(value);
    t.after(() => fs.rmSync(cached, { force: true }));
    t.after(() => fs.rmSync(`${cached}.partial`, { force: true }));
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      return new Response('verified archive');
    };

    assert.equal(await downloadAsset(value), cached);
    assert.equal(attempts, 2);
    assert.equal(fs.readFileSync(cached, 'utf8'), 'verified archive');
    assert.equal(fs.existsSync(`${cached}.partial`), false);
  });

  await t.test('removes partial output before retrying a stream failure', async (t) => {
    const value = target('stream');
    const cached = cachedPath(value);
    t.after(() => fs.rmSync(cached, { force: true }));
    t.after(() => fs.rmSync(`${cached}.partial`, { force: true }));
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      if (attempts > 1) return new Response('complete archive');
      let emitted = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (emitted) {
              controller.error(new Error('socket closed'));
              return;
            }
            emitted = true;
            controller.enqueue(new TextEncoder().encode('partial archive'));
          },
        }),
      );
    };

    assert.equal(await downloadAsset(value), cached);
    assert.equal(attempts, 2);
    assert.equal(fs.readFileSync(cached, 'utf8'), 'complete archive');
    assert.equal(fs.existsSync(`${cached}.partial`), false);
  });

  await t.test('does not retry a permanent HTTP failure', async (t) => {
    const value = target('not-found');
    const cached = cachedPath(value);
    t.after(() => fs.rmSync(cached, { force: true }));
    t.after(() => fs.rmSync(`${cached}.partial`, { force: true }));
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response('missing', { status: 404 });
    };

    await assert.rejects(downloadAsset(value), /returned 404/u);
    assert.equal(attempts, 1);
    assert.equal(fs.existsSync(cached), false);
    assert.equal(fs.existsSync(`${cached}.partial`), false);
  });
});
