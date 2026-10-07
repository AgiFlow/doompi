import type { DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import type { DoomSharedFile } from '@agimon-ai/doompi-core/packageApi';

/** The parts of a catalog tool that declare and name its file parameters. */
export interface McpFileParamTool {
  readonly serverName: string;
  readonly toolName: string;
  readonly inputSchema: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

/** Publishes one workspace or attachment path for one tool call, after consent. */
export type McpFilePublisher = (
  path: string,
  tool: Pick<McpFileParamTool, 'serverName' | 'toolName'>,
  signal?: AbortSignal,
) => Promise<DoomSharedFile>;

/** The ChatGPT Apps file shape a server reads from a declared file parameter. */
export interface McpFileParamValue {
  readonly file_id: string;
  readonly download_url: string;
  readonly file_name: string;
  readonly mime_type: string;
}

export interface McpPublishedFileParams {
  /** What the server receives; the caller's arguments, and so the transcript, keep `{path}`. */
  readonly outbound: Record<string, unknown>;
  /** Revokes every link minted for this call. Idempotent. */
  release(): void;
}

export interface McpConsentedFilePublisherOptions {
  /** The host's tunnel publisher, which asks no consent of its own. */
  readonly shareFile: (path: string, label: string) => Promise<DoomSharedFile>;
  /** Read at call time: the session host can be replaced or detached. */
  readonly host: () => DoomHeadlessHostService | undefined;
  readonly signal?: AbortSignal;
}

/** Audit record for one consent decision. Never holds the link. */
export interface McpFileShareAudit {
  readonly file: string;
  readonly server: string;
  readonly tool: string;
  readonly outcome: 'shared' | 'declined' | 'unanswered';
}
