import { DefaultSandboxExtensionService } from '../services/extensionService.ts';
import type { SandboxExtensionDependencies } from '../types/extension.ts';

export function createSandboxContainer(
  overrides: Partial<SandboxExtensionDependencies> = {},
): SandboxExtensionDependencies {
  return {
    service: overrides.service ?? new DefaultSandboxExtensionService(process.env),
  };
}
