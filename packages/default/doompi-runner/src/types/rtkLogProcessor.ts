export interface IRtkLogProcessor {
  process(logPath: string): Promise<string>;
}
