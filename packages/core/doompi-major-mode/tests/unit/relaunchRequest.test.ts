import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOOM_RELAUNCH_FILE_ENV, parseRelaunchHandoff } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import { requestSupervisedRelaunch, supervisedRelaunchAvailable } from '../../src/adapters/pi/relaunchRequest.ts';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-relaunch-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('requestSupervisedRelaunch', () => {
  it('does nothing without a supervisor listening', () => {
    expect(supervisedRelaunchAvailable({})).toBe(false);
    expect(supervisedRelaunchAvailable({ [DOOM_RELAUNCH_FILE_ENV]: '/tmp/x' })).toBe(true);
    expect(requestSupervisedRelaunch('minimal', 'op', {})).toBe(false);
  });

  it('writes the handoff to the supervised path', () => {
    const file = path.join(workDir, 'session.relaunch.json');
    expect(requestSupervisedRelaunch('minimal', 'op', { [DOOM_RELAUNCH_FILE_ENV]: file })).toBe(true);
    expect(parseRelaunchHandoff(fs.readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      majorMode: 'minimal',
      operationId: 'op',
    });
  });

  it('reports failure when the path is unwritable', () => {
    const file = path.join(workDir, 'missing', 'nested', 'session.relaunch.json');
    expect(requestSupervisedRelaunch('minimal', 'op', { [DOOM_RELAUNCH_FILE_ENV]: file })).toBe(false);
  });
});
