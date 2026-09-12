import { defineCommand } from '@agimon-ai/doompi-core/pi-extension';
import {
  AUTHOR_COMMAND_NAME as COMMAND_NAME,
  AUTHOR_COMMAND_DESCRIPTION as COMMAND_DESCRIPTION,
  AUTHOR_COMMAND_RESULT,
} from '../constants/author';
export {
  AUTHOR_COMMAND_NAME as COMMAND_NAME,
  AUTHOR_COMMAND_DESCRIPTION as COMMAND_DESCRIPTION,
} from '../constants/author';
import type { AuthorExtensionResult, AuthorExtensionService } from '../types/extension';

export function authorCommandResult(): AuthorExtensionResult {
  return AUTHOR_COMMAND_RESULT;
}

export function createAuthorCommand(service?: AuthorExtensionService) {
  return defineCommand({
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    async execute(_args, execution) {
      const result = service ? await service.execute() : authorCommandResult();
      await execution.notify({ body: result.message, level: result.level });
    },
  });
}
