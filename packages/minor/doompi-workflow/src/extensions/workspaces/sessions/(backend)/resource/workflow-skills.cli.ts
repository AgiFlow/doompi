import { defineRoutedContribution, type WithRoot } from '@agimon-ai/doompi-core/extension-file';

import runtime from '../_lib/index.cli';
import { workflowSkillsResource } from '../_lib/workflowSkillsResource';

export default defineRoutedContribution(
  (context: WithRoot<unknown, ReturnType<typeof runtime>>) =>
    workflowSkillsResource(context.root.resources, import.meta.url),
  { cardinality: 'optional' },
);
