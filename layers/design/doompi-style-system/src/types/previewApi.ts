export const STYLE_SYSTEM_PREVIEW_BASE_PATH = 'style-system-preview';

export interface StoryPreviewSeed {
  source?: {
    path: string;
    hasUnsavedChanges: boolean;
  };
}

export interface StoryPreviewMetadataRequest {
  storyPath: string;
  appPath?: string;
}

export interface StoryPreviewExport {
  exportName: string;
  label?: string;
}

export interface StoryPreviewMetadataView {
  storyPath: string;
  appPath: string;
  projectResolution: 'explicit' | 'config' | 'package' | 'workspace';
  exports: readonly StoryPreviewExport[];
}

export interface BuildStoryPreviewRequest {
  appPath: string;
  storyPath: string;
  storyExport: string;
  darkMode?: boolean;
}

export interface BuildStoryPreviewView {
  handle: string;
  html: string;
  storyPath: string;
  storyExport: string;
  sourceSha256: string;
}

export type ExportStoryPreviewImageRequest = BuildStoryPreviewRequest;

export interface ExportStoryPreviewImageView {
  data: string;
  mimeType: 'image/png';
  storyPath: string;
  storyExport: string;
  sourceSha256: string;
}

export interface DisposeStoryPreviewRequest {
  handle: string;
}

export interface DisposeStoryPreviewView {
  disposed: boolean;
}
