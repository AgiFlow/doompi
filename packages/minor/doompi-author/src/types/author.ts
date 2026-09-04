export const AUTHOR_MODE_ID = 'author' as const;

export type AuthorModeActivation = 'inactive' | 'active';

export interface AuthorModeSnapshot {
  activation: AuthorModeActivation;
  catalogToken: string;
  capabilityCount: number;
}

export type AuthorJsonSchema = Readonly<Record<string, unknown>>;

export interface AuthorViewportCapabilityDescriptor {
  name: string;
  label: string;
  description: string;
  inputSchema: AuthorJsonSchema;
}

export interface AuthorViewportCapability extends AuthorViewportCapabilityDescriptor {
  execute(argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface AuthorViewportCatalogSnapshot {
  catalogToken: string;
  tools: AuthorViewportCapabilityDescriptor[];
}

export interface UseAuthorToolInput {
  catalogToken: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AuthorToolResult {
  catalogToken: string;
  name: string;
  result: unknown;
}
