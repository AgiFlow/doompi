import { statSync } from 'node:fs';
import { readWorkflowCatalog, summarizeWorkflow } from '@agimon-ai/workflow-mcp';
import type { HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import {
  createWorkflowCatalogReader,
  presentWorkflowCatalog,
  type WorkflowCatalogReaderDeps,
} from '../services/webWorkflowCatalog.ts';
import { WORKFLOW_CATALOG_TYPE, type WorkflowCatalogPayload } from '../types/webWorkflows.ts';

/** Workflow files change a few times a week; this only has to beat a reload. */
const CATALOG_REFRESH_MS = 15_000;

/** Reads the engine's own catalog, which is what `SPC w l` lists. */
export function defaultCatalogDeps(): WorkflowCatalogReaderDeps {
  return {
    list: (directory) => readWorkflowCatalog(directory),
    summarize: (path) => summarizeWorkflow(path),
    stamp: (path) => {
      try {
        const stats = statSync(path);
        return { size: stats.size, modifiedAt: stats.mtimeMs };
      } catch {
        // The file was listed and then removed. The caller parses it anyway
        // and gets that file's own error, it just cannot cache the answer.
        return undefined;
      }
    },
  };
}

export interface WorkflowCatalogChannelOptions {
  deps?: WorkflowCatalogReaderDeps;
  refreshMs?: number;
}

/**
 * The workflow catalog data channel: what each managed session's directory can
 * launch, published as 'workflow_catalog' payloads.
 *
 * The catalog is read once per session on arrival, again at every subscribe,
 * and on a slow tick so a workflow file written while the page is open shows up
 * without a reload. A failed read publishes an empty list with the reason
 * rather than nothing, because a drawer that says why it is empty beats one
 * that looks like a repository with no workflows.
 */
export function createWorkflowCatalogChannel(options: WorkflowCatalogChannelOptions = {}): WebHubChannel {
  const reader = createWorkflowCatalogReader(options.deps ?? defaultCatalogDeps());
  const refreshMs = options.refreshMs ?? CATALOG_REFRESH_MS;
  return {
    frameType: WORKFLOW_CATALOG_TYPE,
    start(host) {
      const scopes = new Map<string, HubSessionScope>();
      const lastPublished = new Map<string, string>();

      const compute = async (scope: HubSessionScope): Promise<WorkflowCatalogPayload> => {
        try {
          const workflows = presentWorkflowCatalog(await reader.read(scope.cwd));
          return { cwd: scope.cwd, workflows };
        } catch (error) {
          const warning = error instanceof Error ? error.message : String(error);
          return { cwd: scope.cwd, workflows: [], warning };
        }
      };

      /** Which files each session's last read listed, so the parse cache can be trimmed. */
      const listed = new Map<string, Set<string>>();
      const forgetUnlisted = (): void => {
        const keep = new Set<string>();
        for (const paths of listed.values()) {
          for (const path of paths) keep.add(path);
        }
        reader.forget(keep);
      };

      /** Recomputes and remembers; publishes only what changed, so the tick stays quiet. */
      const refresh = async (scope: HubSessionScope): Promise<void> => {
        const payload = await compute(scope);
        listed.set(scope.sessionId, new Set(payload.workflows.map((workflow) => workflow.path)));
        forgetUnlisted();
        const json = JSON.stringify(payload);
        if (lastPublished.get(scope.sessionId) === json) return;
        lastPublished.set(scope.sessionId, json);
        if (payload.warning !== undefined) {
          host.onNotice(`workflow catalog for ${scope.cwd} is unavailable (${payload.warning})`);
        }
        host.publish(scope.sessionId, payload);
      };

      const timer = setInterval(() => {
        for (const scope of scopes.values()) void refresh(scope);
      }, refreshMs);
      timer.unref?.();

      const source: HubChannelSource = {
        /**
         * Reading a directory is asynchronous and a snapshot is not, so a page
         * subscribing gets the last catalog read for its session and the fresh
         * one a moment later on the channel. The first subscriber of a session
         * gets no snapshot and only the published read.
         */
        payloadFor(scope) {
          if (!scopes.has(scope.sessionId)) return undefined;
          void refresh(scope);
          return cached(lastPublished, scope.sessionId);
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          void refresh(scope);
        },
        sessionRemoved(sessionId) {
          scopes.delete(sessionId);
          lastPublished.delete(sessionId);
          listed.delete(sessionId);
          forgetUnlisted();
        },
        close() {
          clearInterval(timer);
        },
      };
      return source;
    },
  };
}

/** The last payload published for a session, so a subscribe answers at once. */
function cached(published: Map<string, string>, sessionId: string): WorkflowCatalogPayload | undefined {
  const json = published.get(sessionId);
  if (json === undefined) return undefined;
  return JSON.parse(json) as WorkflowCatalogPayload;
}
