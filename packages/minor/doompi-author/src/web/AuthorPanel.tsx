import { Button } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import { authorFileTab } from './AuthorDocumentPanel.tsx';
import { author } from './authorStore.ts';
import { authorWorkspace } from './authorWorkspaceStore.ts';
import { AuthorToolPalette } from './AuthorToolPalette.tsx';
import { AuthorRegionDrafts } from './AuthorRegionDrafts.tsx';
import { AuthorRequestLog } from './AuthorRequestLog.tsx';

export function AuthorPanel({ sessionId, openTransientTab }: WebPluginSlotProps) {
  const view = useStore(author.store, (state) => author.select(state, sessionId));
  const documents = useStore(authorWorkspace.store, (state) => {
    if (sessionId === null) return [];
    const prefix = `${sessionId}\n`;
    return Object.entries(state.documents)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, document]) => document);
  });
  const workspace = useStore(authorWorkspace.store, (state) =>
    sessionId === null ? undefined : state.sessions[sessionId],
  );
  const focused = documents.find((document) => document.path === workspace?.focusedDocument?.path);
  return (
    <section data-testid="author-panel" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
      <strong className="text-[11px] text-doom-text">Author {view.activation}</strong>
      <span className="text-[10px] text-doom-faint">
        {view.capabilityCount === 1 ? '1 viewport capability' : `${view.capabilityCount} viewport capabilities`}
      </span>
      {workspace?.focusedDocument === undefined ? null : (
        <span data-testid="author-focused-document" className="text-[10px] text-doom-dim">
          focused: {workspace.focusedDocument.path}
        </span>
      )}
      {sessionId !== null && workspace !== undefined && focused !== undefined ? (
        <>
          <AuthorToolPalette sessionId={sessionId} kind={focused.kind} activeTool={workspace.activeTool} />
          <AuthorRegionDrafts key={focused.path} sessionId={sessionId} workspace={workspace} />
        </>
      ) : null}
      <div className="mt-2 flex flex-col gap-1">
        {documents.length === 0 ? <span className="text-[10px] text-doom-faint">No open documents</span> : null}
        {documents.map((document) => (
          <Button
            key={document.path}
            size="card"
            variant="ghost"
            data-testid="author-open-document"
            className="justify-start text-[11px]"
            onClick={() => openTransientTab(authorFileTab(document.path))}
          >
            {document.title ?? document.path}
          </Button>
        ))}
      </div>
      <AuthorRequestLog requests={workspace?.requests ?? []} />
    </section>
  );
}
