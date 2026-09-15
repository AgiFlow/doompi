import { defineResource } from '@agimon-ai/doompi-core/extension-file';

import { readPromptSkill } from '../../../../../services/savedPrompts';
export default defineResource({ name: 'doompi-use-prompt', kind: 'skill' as const, read: readPromptSkill });
