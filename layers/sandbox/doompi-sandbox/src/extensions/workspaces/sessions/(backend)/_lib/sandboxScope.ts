import type { DefaultSandboxExtensionService } from '../../../../../services/extensionService';
import type { SandboxExtensionService } from '../../../../../types/extension';

export interface SandboxPiScope {
  readonly service: SandboxExtensionService;
}

export interface SandboxServerScope {
  readonly service?: DefaultSandboxExtensionService;
}
