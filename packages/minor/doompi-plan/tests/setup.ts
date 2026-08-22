import { HARNESS_STATE_POINTER, resetHarnessStore } from '@agimon-ai/doompi-config';
import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Global test setup
beforeAll(async () => {
  // Initialize test environment
  vi.clearAllMocks();
});

afterAll(async () => {
  // Cleanup after all tests
  vi.resetAllMocks();
});

beforeEach(() => {
  // Planning config tests must not resolve through the parent Pi process's
  // persisted harness. Tests that need a state file arrange one explicitly.
  delete process.env[HARNESS_STATE_POINTER];
  resetHarnessStore();
  vi.clearAllMocks();
});

afterEach(() => {
  // Cleanup after each test
  vi.clearAllMocks();
});
