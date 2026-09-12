import { defineCommand } from '@agimon-ai/doompi-core/pi-extension';
import { COMMAND_DESCRIPTION, COMMAND_NAME } from '../constants/sandbox';
import type { SandboxExtensionService } from '../types/extension';
export function createSandboxCommand(service: SandboxExtensionService) {
  return defineCommand({
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    async execute(_args, execution) {
      const result = await service.execute();
      await execution.notify({ body: result.message, level: result.level });
    },
  });
}
