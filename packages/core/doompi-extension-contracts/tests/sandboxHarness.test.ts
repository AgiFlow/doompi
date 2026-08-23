import { describe, expect, it } from 'vitest';
import {
  DOOMPI_SANDBOX_ENV,
  insideSandbox,
  isSandboxHarnessModule,
  SANDBOX_HARNESS_EXPORT_SUBPATH,
} from '../src/schemas/sandboxHarness.ts';

describe('sandbox harness contract', () => {
  it('names the exports subpath a providing layer declares', () => {
    expect(SANDBOX_HARNESS_EXPORT_SUBPATH).toBe('./sandbox-harness');
  });

  it('detects a sandboxed process only from the exact marker value', () => {
    expect(insideSandbox({})).toBe(false);
    expect(insideSandbox({ [DOOMPI_SANDBOX_ENV]: '' })).toBe(false);
    expect(insideSandbox({ [DOOMPI_SANDBOX_ENV]: 'true' })).toBe(false);
    expect(insideSandbox({ [DOOMPI_SANDBOX_ENV]: '1' })).toBe(true);
  });

  it('accepts only modules exposing a launchSandbox function', () => {
    expect(isSandboxHarnessModule(undefined)).toBe(false);
    expect(isSandboxHarnessModule({})).toBe(false);
    expect(isSandboxHarnessModule({ launchSandbox: 'later' })).toBe(false);
    expect(isSandboxHarnessModule({ launchSandbox: async () => 0 })).toBe(true);
  });
});
