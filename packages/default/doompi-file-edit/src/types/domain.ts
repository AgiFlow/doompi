export type FileEditTool = 'edit' | 'write' | 'bash';
export type FileEditState = 'modified' | 'added' | 'deleted' | 'unchanged' | 'binary' | 'external';

export interface TimelineEvent {
  version: 1;
  path: string;
  tool: FileEditTool;
  at: number;
}

export interface FileEditEntry {
  path: string;
  tool: FileEditTool;
  at: number;
  count: number;
}

export interface FileDiff {
  path: string;
  state: FileEditState;
  lines: string[];
  additions: number;
  removals: number;
  tracked: boolean;
  truncated: boolean;
  suggestedLine: number;
}

export interface ResolvedEditor {
  template: string;
  source: 'configured' | 'VISUAL' | 'EDITOR' | 'fallback';
}
