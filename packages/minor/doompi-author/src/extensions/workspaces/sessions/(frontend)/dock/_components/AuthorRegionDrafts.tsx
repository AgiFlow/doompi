import { Button } from '@agimon-ai/doompi-web-components';
import { useState } from 'react';

import type { AuthorDocumentAnnotationCollection } from '../../_lib/authorWorkspaceStore';
import {
  commitAuthorRegion,
  removeAuthorRegion,
  seekAuthorVideo,
  setAuthorCandidateText,
  setAuthorRegionCandidate,
} from '../../_lib/authorWorkspaceStore';

export function AuthorRegionDrafts({
  sessionId,
  path,
  drafts,
}: {
  sessionId: string;
  path: string;
  drafts: AuthorDocumentAnnotationCollection;
}) {
  const [error, setError] = useState<string>();
  const add = () => {
    try {
      commitAuthorRegion(sessionId, path, drafts.candidateText);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  if (!drafts.candidate && drafts.annotations.length === 0) return null;
  const candidateKind = drafts.candidate?.mode === 'point' ? 'point' : 'region';
  return (
    <section className="space-y-2" data-testid="author-region-drafts">
      {drafts.candidate ? (
        <>
          <h3 className="text-base font-semibold text-doom-text">Current {candidateKind}</h3>
          <p className="text-base text-doom-dim sm:text-sm">
            Add feedback to keep this {candidateKind} as an unsent annotation.
          </p>
          {drafts.candidate.anchor.kind === 'video-time-rect' || drafts.candidate.anchor.kind === 'video-time-point' ? (
            <p className="text-base text-doom-dim sm:text-sm">
              Frame at {drafts.candidate.anchor.timeSeconds.toFixed(3)}s
            </p>
          ) : null}
          <textarea
            aria-label="Annotation comment"
            value={drafts.candidateText}
            onChange={(event) => setAuthorCandidateText(sessionId, path, event.target.value)}
            placeholder="What should change here?"
            rows={3}
            className="min-h-11 w-full resize-y rounded border border-doom-border bg-doom-deep p-2 text-lg leading-normal text-doom-text focus:border-doom-red focus:outline-none sm:text-sm"
          />
          <Button
            className="min-h-11 min-w-11 text-base [@media(pointer:fine)]:min-h-8 sm:text-sm"
            variant="outline"
            onClick={add}
            disabled={!drafts.candidate || !drafts.candidateText.trim() || drafts.annotations.length >= 16}
          >
            add annotation
          </Button>
          <Button
            variant="ghost"
            className="min-h-11 min-w-11 text-base [@media(pointer:fine)]:min-h-8 sm:text-sm"
            onClick={() => {
              setAuthorRegionCandidate(sessionId, path, undefined);
              setAuthorCandidateText(sessionId, path, '');
              setError(undefined);
            }}
          >
            Discard annotation
          </Button>
        </>
      ) : null}
      {error ? <output className="block text-base text-doom-red">{error}</output> : null}
      {drafts.annotations.length > 0 ? (
        <h3 className="text-base font-semibold text-doom-text">Unsent annotations ({drafts.annotations.length})</h3>
      ) : null}
      <ol className="space-y-2">
        {drafts.annotations.map((region, index) => (
          <li
            key={region.id}
            className="rounded border border-doom-border bg-doom-panel p-2 text-base leading-normal text-doom-text sm:text-sm"
          >
            <span>
              ({index + 1}) {region.mode === 'point' ? 'Point' : 'Region'}: {region.comment}
            </span>
            {region.anchor.kind === 'video-time-rect' || region.anchor.kind === 'video-time-point' ? (
              <Button
                variant="outline"
                className="min-h-11 min-w-11 text-base [@media(pointer:fine)]:min-h-8 sm:text-sm"
                disabled={drafts.candidate !== undefined}
                onClick={() => {
                  if (region.anchor.kind === 'video-time-rect' || region.anchor.kind === 'video-time-point') {
                    seekAuthorVideo(sessionId, path, region.anchor.timeSeconds);
                  }
                }}
              >
                Go to {region.anchor.timeSeconds.toFixed(3)}s
              </Button>
            ) : null}
            <Button
              className="min-h-11 min-w-11 text-base [@media(pointer:fine)]:min-h-8 sm:text-sm"
              variant="ghost"
              aria-label={`Remove annotation ${index + 1}`}
              onClick={() => removeAuthorRegion(sessionId, path, region.id)}
            >
              remove
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
