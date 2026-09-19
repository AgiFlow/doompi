import type { BaseBundlerService, ComponentRendererService, DesignSystemConfig } from '@agimon-ai/style-system';

export interface StoryPreviewBuildInput {
  appPath: string;
  storyPath: string;
  storyExport: string;
  args?: Record<string, unknown>;
  darkMode?: boolean;
}

export interface StoryPreviewBuildResult {
  handle: string;
  html: string;
  storyPath: string;
  storyExport: string;
  sourceSha256: string;
}

export interface StoryPreviewImageResult {
  data: string;
  mimeType: 'image/png';
  captureId: string;
  width: number;
  height: number;
  storyPath: string;
  storyExport: string;
  sourceSha256: string;
}

export type StoryPreviewRenderer = Pick<ComponentRendererService, 'renderComponent' | 'dispose'>;

export interface StoryPreviewServiceDependencies {
  loadConfig(appPath: string): Promise<DesignSystemConfig>;
  createBundler(config: DesignSystemConfig): BaseBundlerService;
  createRenderer(config: DesignSystemConfig, appPath: string): StoryPreviewRenderer;
  rendererTemporaryRoot(): string;
  createHandle(): string;
}
