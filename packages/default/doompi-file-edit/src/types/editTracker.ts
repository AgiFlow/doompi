export interface IEditTracker {
  start(id: string, tool: string, args: unknown, cwd: string): Promise<void>;
  end(id: string, isError: boolean): Promise<void>;
}
