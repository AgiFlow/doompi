import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_STATE_POINTER, resetHarnessStore } from '@agimon-ai/doompi-config';
import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * Pi's agent directory, redirected for the whole suite.
 *
 * A plan run records where its plan landed so the session's API server can
 * find it, and the real adapter puts that under the developer's own
 * ~/.pi/agent. Every writePlan test would otherwise leave a record there for a
 * session that no longer exists.
 */
const agentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-plan-agent-'));
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;

// Global test setup
beforeAll(async () => {
  // Initialize test environment
  vi.clearAllMocks();
});

afterAll(async () => {
  if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
  fs.rmSync(agentDirectory, { recursive: true, force: true });
  // Cleanup after all tests
  vi.resetAllMocks();
});

beforeEach(() => {
  // Planning config tests must not resolve through the parent Pi process's
  // persisted harness. Tests that need a state file arrange one explicitly.
  delete process.env[HARNESS_STATE_POINTER];
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  resetHarnessStore();
  vi.clearAllMocks();
});

afterEach(() => {
  // Cleanup after each test
  vi.clearAllMocks();
});
