import type { TSchema } from 'typebox';

import type { DoomHeadlessToolResult } from '../../schemas/headless';

export interface SessionToolDescriptor {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
}

export interface SessionSkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly uri: string;
}

export interface SessionToolSurfaceSnapshot {
  readonly revision: number;
  readonly tools: readonly SessionToolDescriptor[];
  readonly skills: readonly SessionSkillDescriptor[];
}

export interface SessionToolInvocation {
  readonly revision: number;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly onUpdate?: (result: DoomHeadlessToolResult) => void;
}

/** Live, session-owned boundary used by transports that expose the applied capability surface. */
export interface SessionToolSurface {
  readSurface(): SessionToolSurfaceSnapshot;
  invokeTool(invocation: SessionToolInvocation): Promise<DoomHeadlessToolResult>;
  readSkill(revision: number, uri: string): string | Promise<string>;
}
