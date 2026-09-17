export const STYLE_SYSTEM_PREVIEW_BASE_PATH = 'style-system-preview';

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
}

export interface DisposeStoryPreviewRequest {
  handle: string;
}

export interface DisposeStoryPreviewView {
  disposed: boolean;
}
