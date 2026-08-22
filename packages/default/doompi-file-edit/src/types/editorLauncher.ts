import type { ResolvedEditor } from './domain';

export interface EditorTui {
  stop(): void;
  start(): void;
  requestRender(force?: boolean): void;
}

export interface EditorLaunchResult {
  success: boolean;
  error?: string;
}

export interface IEditorLauncher {
  resolve(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Promise<ResolvedEditor | undefined>;
  launch(filePath: string, line: number, tui: EditorTui): Promise<EditorLaunchResult>;
}
