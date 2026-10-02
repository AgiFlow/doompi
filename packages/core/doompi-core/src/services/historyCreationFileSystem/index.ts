/** Retained legacy entrypoint. Durable containers do not create JSONL histories. */
export function createHistoryCreationFileSystem<T>(
  _backend: T,
  _beforeCreate: (destinationPath: string) => Promise<void>,
): T {
  throw new Error('Legacy JSONL history creation is unsupported by fresh durable storage');
}
