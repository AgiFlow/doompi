import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import type { AuthorSessionWorkspace } from './authorWorkspaceStore.ts';
import { commitAuthorRegion, removeAuthorRegion } from './authorWorkspaceStore.ts';

export function AuthorRegionDrafts({ sessionId, workspace }: { sessionId: string; workspace: AuthorSessionWorkspace }) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();
  const add = () => {
    try {
      commitAuthorRegion(sessionId, comment);
      setComment('');
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  if (!workspace.candidate && workspace.regions.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="author-region-drafts">
      {workspace.candidate ? (
        <>
          <p className="text-[9px] font-bold tracking-widest text-doom-faint">REGION COMMENT</p>
          <textarea
            aria-label="Region comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What should change here?"
            rows={4}
            className="w-full resize-y rounded border border-doom-border bg-doom-deep p-2 text-[11px] leading-relaxed text-doom-text focus:border-doom-red focus:outline-none"
          />
          <Button
            size="xs"
            variant="outline"
            onClick={add}
            disabled={!workspace.candidate || !comment.trim() || workspace.regions.length >= 16}
          >
            add region
          </Button>
        </>
      ) : null}
      {error ? <output className="block text-[10px] text-doom-red">{error}</output> : null}
      <ol className="space-y-2">
        {workspace.regions.map((region, index) => (
          <li
            key={region.id}
            className="rounded border border-doom-border bg-doom-panel p-2 text-[11px] leading-relaxed text-doom-text"
          >
            <span>
              ({index + 1}) {region.comment}
            </span>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Remove region ${index + 1}`}
              onClick={() => removeAuthorRegion(sessionId, region.id)}
            >
              remove
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
