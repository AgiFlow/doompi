import { Button } from '@agimon-ai/doompi-web-components';
import type { AuthorDocumentKind, AuthorToolMode } from './authorViewportTypes.ts';
import { setAuthorToolMode } from './authorWorkspaceStore.ts';

export function AuthorToolPalette({
  sessionId,
  kind,
  activeTool,
}: {
  sessionId: string;
  kind: AuthorDocumentKind;
  activeTool: AuthorToolMode;
}) {
  const tools: AuthorToolMode[] = kind === 'image' ? ['select', 'mark', 'crop'] : ['select', 'mark'];
  return (
    <section data-testid="author-tool-palette" className="space-y-2">
      <p className="text-[10px] text-doom-dim">
        {kind} · {kind === 'pdf' || kind === 'video' ? 'selection and capture only' : 'editable draft'}
      </p>
      <div className="flex flex-wrap gap-2">
        {tools.map((tool) => (
          <Button
            key={tool}
            size="xs"
            variant={activeTool === tool ? 'outline' : 'ghost'}
            aria-pressed={activeTool === tool}
            onClick={() => setAuthorToolMode(sessionId, tool)}
          >
            {tool === 'mark' ? 'mark region' : tool}
          </Button>
        ))}
      </div>
    </section>
  );
}
