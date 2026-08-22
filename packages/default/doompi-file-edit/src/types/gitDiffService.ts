import type { FileDiff } from './domain';

export interface IGitDiffService {
  diff(cwd: string, filePath: string): Promise<FileDiff>;
}
