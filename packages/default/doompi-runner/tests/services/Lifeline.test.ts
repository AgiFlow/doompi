import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeLifeline } from '../../src/adapters/Lifeline/NodeLifeline';
import { LIFELINE_ENV, watchOwner } from '../../src/adapters/Lifeline/client';
import { FakeRunnerPaths } from '../doubles.ts';

let directory: string;
let previousLifeline: string | undefined;

function pathsFor(): FakeRunnerPaths {
  return new FakeRunnerPaths(directory);
}

async function settle(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-lifeline-')));
  previousLifeline = process.env[LIFELINE_ENV];
  delete process.env[LIFELINE_ENV];
});

afterEach(() => {
  if (previousLifeline === undefined) delete process.env[LIFELINE_ENV];
  else process.env[LIFELINE_ENV] = previousLifeline;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('NodeLifeline', () => {
  it('listens on a socket and publishes it to spawned runners', async () => {
    const lifeline = new NodeLifeline(pathsFor());

    const target = await lifeline.arm('session-a');

    expect(target).toBeDefined();
    expect(fs.statSync(target as string).isSocket()).toBe(true);
    expect(process.env[LIFELINE_ENV]).toBe(target);
    lifeline.dispose();
  });

  it('is idempotent and cleans up on dispose', async () => {
    const lifeline = new NodeLifeline(pathsFor());
    const first = await lifeline.arm('session-a');

    expect(await lifeline.arm('session-a')).toBe(first);
    expect(lifeline.path()).toBe(first);

    lifeline.dispose();

    expect(fs.existsSync(first as string)).toBe(false);
    expect(lifeline.path()).toBeUndefined();
    expect(process.env[LIFELINE_ENV]).toBeUndefined();
  });

  it('replaces a socket left behind by a killed predecessor', async () => {
    const first = new NodeLifeline(pathsFor());
    const target = (await first.arm('session-a')) as string;
    first.dispose();
    // A predecessor killed outright leaves the socket file with nothing behind it.
    fs.writeFileSync(target, '');

    const successor = new NodeLifeline(pathsFor());

    expect(await successor.arm('session-a')).toBe(target);
    expect(fs.statSync(target).isSocket()).toBe(true);
    successor.dispose();
  });

  it('accepts a runner without keeping the owner process alive', async () => {
    const lifeline = new NodeLifeline(pathsFor());
    const target = (await lifeline.arm('session-a')) as string;

    const connection = net.connect(target);
    await new Promise((resolve, reject) => {
      connection.once('connect', resolve);
      connection.once('error', reject);
    });

    expect(connection.destroyed).toBe(false);
    connection.destroy();
    lifeline.dispose();
  });
});

describe('watchOwner', () => {
  it('does nothing when no lifeline is armed', () => {
    let lost = false;

    const detach = watchOwner(() => {
      lost = true;
    }, undefined);
    detach();

    expect(lost).toBe(false);
  });

  it('reports the owner dying while the runner is still going', async () => {
    const lifeline = new NodeLifeline(pathsFor());
    const target = (await lifeline.arm('session-a')) as string;
    let lost = false;
    watchOwner(() => {
      lost = true;
    }, target);
    await settle(() => false, 100);

    expect(lost).toBe(false);

    // Stands in for the owning pi dying: the socket drops either way.
    lifeline.dispose();

    expect(await settle(() => lost)).toBe(true);
  });

  it('reports an owner that was already gone before the runner started', async () => {
    let lost = false;

    watchOwner(
      () => {
        lost = true;
      },
      path.join(directory, 'never-listened.sock'),
    );

    expect(await settle(() => lost)).toBe(true);
  });

  it('stops reporting once detached', async () => {
    const lifeline = new NodeLifeline(pathsFor());
    const target = (await lifeline.arm('session-a')) as string;
    let lost = false;

    const detach = watchOwner(() => {
      lost = true;
    }, target);
    detach();
    lifeline.dispose();

    expect(await settle(() => lost, 300)).toBe(false);
  });
});
