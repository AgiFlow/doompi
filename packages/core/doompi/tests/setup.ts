import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_STATE_POINTER, resetHarnessStore } from '@agimon-ai/doompi-config';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

// Point HOME at an empty directory before any test module is imported. Every
// .doom document layers ~/.pi/.doom underneath the repository copy, so without
// this a developer who has run `doompi init` would have their own layers,
// domains and profiles merged into these fixtures.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-test-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

// Global test setup
beforeAll(async () => {
  // Initialize test environment
  vi.clearAllMocks();
});

afterAll(async () => {
  // Cleanup after all tests
  vi.resetAllMocks();
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

beforeEach(() => {
  // Unit tests start outside the parent Pi process's persisted harness.
  // Cases that exercise persisted state arrange their own pointer explicitly.
  delete process.env[HARNESS_STATE_POINTER];
  resetHarnessStore();
  vi.clearAllMocks();
});

afterEach(() => {
  // Cleanup after each test
  vi.clearAllMocks();
});
