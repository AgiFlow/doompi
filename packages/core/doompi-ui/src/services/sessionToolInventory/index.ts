export function toolNames(entries: readonly Record<string, unknown>[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const message = entry.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const name = (block as { name?: unknown }).name;
      if (typeof name === 'string' && name) names.add(name);
    }
  }
  return [...names].sort();
}
