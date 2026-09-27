import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';

import type { McpSessionToolDetail } from '../../../../../../types/webMcp';
import { fetchSessionTool } from '../_lib/mcpSessionToolApi';

export interface McpToolTarget {
  sessionId: string;
  server: string;
  tool: string;
}

type Loaded = { key: string; detail?: McpSessionToolDetail; error?: string };

function keyOf(target: McpToolTarget): string {
  return `${target.sessionId}\u0000${target.server}\u0000${target.tool}`;
}

/** What one reachable MCP tool would put in context: its description and input schema. */
export function McpToolDetailDialog({ target, onClose }: { target: McpToolTarget | null; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (target === null) return;
    let live = true;
    const key = keyOf(target);
    void fetchSessionTool(target.sessionId, target.server, target.tool).then((result) => {
      if (!live) return;
      setLoaded(result.ok ? { key, detail: result.detail } : { key, error: result.error });
    });
    return () => {
      live = false;
    };
  }, [target]);

  // A response for another row is never shown under this one's title.
  const current = target !== null && loaded?.key === keyOf(target) ? loaded : null;
  const detail = current?.detail;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="mcp-tool-detail-dialog">
        <DialogHeader className="items-start px-4 py-4 sm:px-5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <DialogTitle className="break-words text-base leading-snug">
              {target === null ? '' : `${target.server} · ${target.tool}`}
            </DialogTitle>
            <DialogDescription>
              {detail === undefined
                ? 'Reached through mcp_use, so it is not in the model context.'
                : `Reached through mcp_use, so it is not in the model context. Added directly it would cost ~${detail.tokens.toLocaleString()} tokens.`}
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 px-4 py-4 sm:px-5 sm:py-5">
          {current === null ? <output className="text-sm text-doom-dim">Loading the tool...</output> : null}
          {current?.error === undefined ? null : <output className="text-sm text-doom-dim">{current.error}</output>}
          {detail === undefined ? null : (
            <>
              <section className="flex flex-col gap-1">
                <p className="text-2xs font-bold uppercase tracking-wide text-doom-faint">description</p>
                <p className="whitespace-pre-wrap text-sm text-doom-text">{detail.description ?? 'No description.'}</p>
              </section>
              <section className="flex min-h-0 flex-col gap-1">
                <p className="text-2xs font-bold uppercase tracking-wide text-doom-faint">input schema</p>
                <pre
                  data-testid="mcp-tool-detail-schema"
                  className="max-h-96 overflow-auto rounded border border-doom-border-soft p-2 text-xs text-doom-text"
                >
                  {JSON.stringify(detail.inputSchema, null, 2)}
                </pre>
              </section>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
