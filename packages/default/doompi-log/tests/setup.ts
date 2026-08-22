import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

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
  // Setup before each test
  vi.clearAllMocks();
});

afterEach(() => {
  // Cleanup after each test
  vi.clearAllMocks();
});
