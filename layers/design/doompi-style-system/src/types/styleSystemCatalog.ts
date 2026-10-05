import type { StoryPreviewExport } from './previewApi';

export interface StyleSystemCatalogProject {
  appPath: string;
  configPath: string;
  preset?: string;
  bundler?: string;
  settings: Record<string, unknown>;
  provenance: { presets: string[]; projectConfigPath?: string };
  error?: string;
}

export interface StyleSystemCatalogComponent {
  storyPath: string;
  title: string;
  tags: string[];
  exports: StoryPreviewExport[];
  projectPath?: string;
  shared: boolean;
}

export interface StyleSystemCatalogView {
  projects: StyleSystemCatalogProject[];
  components: StyleSystemCatalogComponent[];
  workspace?: { configPath: string; settings: Record<string, unknown>; sharedComponentTags: string[] };
  diagnostics: { path: string; message: string }[];
  truncated: boolean;
}

export interface StyleSystemCatalogRequest {
  refresh?: boolean;
}
