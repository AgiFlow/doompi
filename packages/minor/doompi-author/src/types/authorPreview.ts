export interface AuthorStoryPreviewSource {
  path: string;
  sha256: string;
}

/** Browser-safe identity retained with an immutable story-preview capture. */
export interface AuthorStoryPreviewIdentity {
  version: 1;
  provider: string;
  projectPath: string;
  storyPath: string;
  storyExport: string;
  buildRevision: string;
  viewport: { width: number; height: number };
  sources: readonly AuthorStoryPreviewSource[];
}
