import type { TSchema } from 'typebox';

import type { DoomHeadlessTool, DoomHeadlessToolResult, DoomMcpSkillAccess } from '../../schemas/headless';
import type { DoomMcpUiResource } from '../../schemas/mcpFacet';

export interface SessionToolDescriptor {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly annotations?: DoomHeadlessTool['annotations'];
  readonly outputSchema?: DoomHeadlessTool['outputSchema'];
  readonly _meta?: DoomHeadlessTool['_meta'];
}

export interface SessionSkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly uri: string;
}

export type SessionUiResourceDescriptor = Omit<DoomMcpUiResource, 'read'>;

export interface SessionToolSurfaceSnapshot {
  readonly revision: number;
  readonly tools: readonly SessionToolDescriptor[];
  readonly skills: readonly SessionSkillDescriptor[];
  readonly uiResources?: readonly SessionUiResourceDescriptor[];
}

export interface SessionToolInvocation {
  readonly revision: number;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly signal?: AbortSignal;
  /** Grant-filtered remote skills for this invocation only. */
  readonly mcpSkills?: DoomMcpSkillAccess;
  readonly authorize?: () => void | Promise<void>;
  readonly onUpdate?: (result: DoomHeadlessToolResult) => void;
}

/** Live, session-owned boundary used by transports that expose the applied capability surface. */
export interface SessionToolSurface {
  readSurface(): SessionToolSurfaceSnapshot;
  invokeTool(invocation: SessionToolInvocation): Promise<DoomHeadlessToolResult>;
  readSkill(revision: number, uri: string): string | Promise<string>;
  readUiResource?(revision: number, uri: string): string | Promise<string>;
}
