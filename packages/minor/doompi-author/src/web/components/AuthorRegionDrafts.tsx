import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';
import type { AuthorSessionWorkspace } from '../stores/authorWorkspaceStore.ts';
import {
  commitAuthorRegion,
  removeAuthorRegion,
  seekAuthorVideo,
  setAuthorRegionCandidate,
} from '../stores/authorWorkspaceStore.ts';

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
          <h3 className="text-sm font-semibold text-doom-text">Current selection</h3>
          <p className="text-sm text-doom-dim sm:text-xs">Add a comment to keep this selection as an unsent draft.</p>
          {workspace.candidate.anchor.kind === 'video-time-rect' ? (
            <p className="text-sm text-doom-dim sm:text-xs">
              Frame at {workspace.candidate.anchor.timeSeconds.toFixed(3)}s
            </p>
          ) : null}
          <textarea
            aria-label="Region comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What should change here?"
            rows={3}
            className="min-h-11 w-full resize-y rounded border border-doom-border bg-doom-deep p-2 text-base leading-normal text-doom-text focus:border-doom-red focus:outline-none sm:text-xs"
          />
          <Button
            className="min-h-11 min-w-11 text-sm [@media(pointer:fine)]:min-h-8 sm:text-xs"
            variant="outline"
            onClick={add}
            disabled={!workspace.candidate || !comment.trim() || workspace.regions.length >= 16}
          >
            add region
          </Button>
          <Button
            variant="ghost"
            className="min-h-11 min-w-11 text-sm [@media(pointer:fine)]:min-h-8 sm:text-xs"
            onClick={() => {
              setAuthorRegionCandidate(sessionId, undefined);
              setComment('');
              setError(undefined);
            }}
          >
            Discard selection
          </Button>
        </>
      ) : null}
      {error ? <output className="block text-sm text-doom-red">{error}</output> : null}
      {workspace.regions.length > 0 ? (
        <h3 className="text-sm font-semibold text-doom-text">Unsent drafts ({workspace.regions.length})</h3>
      ) : null}
      <ol className="space-y-2">
        {workspace.regions.map((region, index) => (
          <li
            key={region.id}
            className="rounded border border-doom-border bg-doom-panel p-2 text-sm leading-normal text-doom-text sm:text-xs"
          >
            <span>
              ({index + 1}) {region.comment}
            </span>
            {region.anchor.kind === 'video-time-rect' ? (
              <Button
                variant="outline"
                className="min-h-11 min-w-11 text-sm [@media(pointer:fine)]:min-h-8 sm:text-xs"
                disabled={workspace.candidate !== undefined}
                onClick={() => {
                  if (region.anchor.kind === 'video-time-rect') seekAuthorVideo(sessionId, region.anchor.timeSeconds);
                }}
              >
                Go to {region.anchor.timeSeconds.toFixed(3)}s
              </Button>
            ) : null}
            <Button
              className="min-h-11 min-w-11 text-sm [@media(pointer:fine)]:min-h-8 sm:text-xs"
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
