import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readAsyncRunStatusAt,
  readAsyncRunStatusAtAsync,
  readAsyncRunStatusResultAt,
  readAsyncRunStatusResultAtAsync,
} from '../../src/adapters/statusReader';

let tempDir: string;
let statusPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-status-reader-'));
  statusPath = path.join(tempDir, 'status.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('readAsyncRunStatusAt', () => {
  it('returns undefined, not a throw, when the file does not exist', () => {
    expect(readAsyncRunStatusAt(statusPath)).toBeUndefined();
  });

  it('returns undefined, not a throw, when the file is not valid JSON', () => {
    fs.writeFileSync(statusPath, '{not json', 'utf-8');
    expect(readAsyncRunStatusAt(statusPath)).toBeUndefined();
  });

  it('parses and returns the status object when the file is valid JSON', () => {
    fs.writeFileSync(statusPath, JSON.stringify({ runId: 'run-1', agent: 'reviewer', state: 'running' }), 'utf-8');
    expect(readAsyncRunStatusAt(statusPath)).toEqual({ runId: 'run-1', agent: 'reviewer', state: 'running' });
  });

  it('reads status through the promise-based startup path', async () => {
    fs.writeFileSync(statusPath, JSON.stringify({ runId: 'run-1', agent: 'reviewer', state: 'running' }), 'utf-8');

    await expect(readAsyncRunStatusAtAsync(statusPath)).resolves.toEqual({
      runId: 'run-1',
      agent: 'reviewer',
      state: 'running',
    });
  });

  it('preserves missing, malformed, incompatible, and I/O failure reasons asynchronously', async () => {
    await expect(readAsyncRunStatusResultAtAsync(statusPath)).resolves.toMatchObject({ kind: 'missing' });
    await expect(readAsyncRunStatusAtAsync(statusPath)).resolves.toBeUndefined();

    fs.writeFileSync(statusPath, '{bad json', 'utf8');
    await expect(readAsyncRunStatusResultAtAsync(statusPath)).resolves.toMatchObject({ kind: 'malformed' });

    fs.writeFileSync(statusPath, JSON.stringify({ runId: 'run-1', agent: 'reviewer' }), 'utf8');
    await expect(readAsyncRunStatusResultAtAsync(statusPath)).resolves.toMatchObject({ kind: 'malformed' });

    fs.writeFileSync(
      statusPath,
      JSON.stringify({ version: 99, runId: 'run-1', agent: 'reviewer', state: 'running' }),
      'utf8',
    );
    await expect(readAsyncRunStatusResultAtAsync(statusPath)).resolves.toMatchObject({ kind: 'incompatible' });

    await expect(readAsyncRunStatusResultAtAsync(tempDir)).resolves.toMatchObject({ kind: 'io_error' });
  });

  it('maps legacy fields through the asynchronous reader', async () => {
    fs.writeFileSync(
      statusPath,
      JSON.stringify({ runId: 'run-1', agent: 'reviewer', state: 'complete', reason: 'needs-input' }),
      'utf8',
    );

    await expect(readAsyncRunStatusAtAsync(statusPath)).resolves.toMatchObject({
      state: 'completed',
      attentionReason: 'needs-input',
    });
  });

  it('distinguishes missing, malformed and incompatible status files', () => {
    expect(readAsyncRunStatusResultAt(statusPath).kind).toBe('missing');
    fs.writeFileSync(statusPath, '{bad json', 'utf8');
    expect(readAsyncRunStatusResultAt(statusPath).kind).toBe('malformed');
    fs.writeFileSync(
      statusPath,
      JSON.stringify({ version: 99, runId: 'run-1', agent: 'reviewer', state: 'running' }),
      'utf8',
    );
    expect(readAsyncRunStatusResultAt(statusPath).kind).toBe('incompatible');
  });

  it('maps legacy complete and reason fields only while reading', () => {
    fs.writeFileSync(
      statusPath,
      JSON.stringify({ runId: 'run-1', agent: 'reviewer', state: 'complete', reason: 'needs-input' }),
      'utf8',
    );
    expect(readAsyncRunStatusAt(statusPath)).toMatchObject({
      state: 'completed',
      attentionReason: 'needs-input',
    });
  });
});
