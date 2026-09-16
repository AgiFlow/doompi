export function selectionMetadata(execution: {
  readonly selection: {
    readonly profile?: string;
    readonly domains: readonly string[];
    readonly majorMode: string;
    readonly activeLayers: readonly string[];
  };
}): string {
  return JSON.stringify({
    profile: execution.selection.profile ?? null,
    domains: execution.selection.domains,
    majorMode: execution.selection.majorMode,
    activeLayers: execution.selection.activeLayers,
  });
}
