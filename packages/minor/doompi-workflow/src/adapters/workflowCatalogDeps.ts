import { statSync } from 'node:fs';
import { readWorkflowCatalog, summarizeWorkflow } from '@agimon-ai/workflow-mcp';
import type { WorkflowCatalogReaderDeps } from '../services/webWorkflowCatalog.ts';

/** Connect the pure catalog projection service to the workflow engine and filesystem. */
export function defaultCatalogDeps(): WorkflowCatalogReaderDeps {
  return {
    list: (directory) => readWorkflowCatalog(directory),
    summarize: (workflowPath) => summarizeWorkflow(workflowPath),
    stamp: (workflowPath) => {
      try {
        const stats = statSync(workflowPath);
        return { size: stats.size, modifiedAt: stats.mtimeMs };
      } catch {
        return undefined;
      }
    },
  };
}
