import { statSync } from 'node:fs';

import { diagnoseWorkflow, readWorkflowCatalog, summarizeWorkflow } from '@agimon-ai/workflow-mcp';

import { DOOMPI_RUN_CONFIG_KEYS } from '../../schemas/runConfig';
import type { WorkflowCatalogReaderDeps } from '../webWorkflowCatalog';

/**
 * Connect the pure catalog projection service to the workflow engine and filesystem.
 *
 * A workflow that parses can still be one DoomPi would fail mid-run, such as
 * a step whose runConfig misspells `majorMode`. The engine's doctor, told the
 * keys DoomPi reads, finds those; its errors mark the workflow as one that
 * cannot launch, in the catalog and at every launch, rather than at the step.
 */
export function defaultCatalogDeps(): WorkflowCatalogReaderDeps {
  return {
    list: (directory) => readWorkflowCatalog(directory),
    summarize: (workflowPath) => {
      const detail = summarizeWorkflow(workflowPath);
      if (detail.error !== undefined) return detail;
      const errors = diagnoseWorkflow(workflowPath, { runConfigKeys: DOOMPI_RUN_CONFIG_KEYS }).diagnostics.filter(
        (diagnostic) => diagnostic.level === 'error',
      );
      if (errors.length === 0) return detail;
      return {
        ...detail,
        error: errors
          .map((diagnostic) =>
            diagnostic.location === undefined ? diagnostic.message : `${diagnostic.location}: ${diagnostic.message}`,
          )
          .join('\n'),
      };
    },
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
