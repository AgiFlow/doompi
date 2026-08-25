/**
 * The wire contract between this package's hub API and its cockpit client:
 * one run's terminal, and the files its run directory holds.
 *
 * Both halves of the cockpit import these names, so the route strings and the
 * event names live here rather than being spelled twice.
 */

/** Segment this package's API is mounted under, below /api/plugin/. */
export const WORKFLOW_API_BASE_PATH = 'workflow';

/** The SSE event name the screen stream writes. */
export const WORKFLOW_SCREEN_EVENT = 'screen';

/** Where a run's routes live, below the mount every hub-scoped package API shares. */
export function workflowRunPath(workspace: string, runKey: string): string {
  return `/api/plugin/${WORKFLOW_API_BASE_PATH}/runs/${encodeURIComponent(workspace)}/${encodeURIComponent(runKey)}`;
}

/** What a surface may do with one run's terminal, and why anything is missing. */
export interface WorkflowTerminalCapabilitiesView {
  readable: boolean;
  writable: boolean;
  resizable: boolean;
  reason?: string;
}

/** One frame of a run's terminal, as the stream pushes it. */
export interface WorkflowScreenEvent {
  /** The visible screen, newest line last, carrying the colour the run printed. */
  lines: string[];
  capabilities: WorkflowTerminalCapabilitiesView;
  /** True once the run has settled, after which the stream ends. */
  ended?: boolean;
}

/** Answer to taking or releasing the keyboard for one run. */
export interface WorkflowControlResponse {
  /** True when this caller now holds the keyboard. */
  held: boolean;
  /** The token later writes must carry; absent when control was refused or released. */
  token?: string;
  /** Why control was refused, worded for a reader. */
  reason?: string;
}

/** How a declared run-directory entry compares with what is on disk. */
export type WorkflowArtifactState = 'written' | 'empty' | 'pending' | 'unreadable';

/** One file or directory in a run's own folder. */
export interface WorkflowArtifactView {
  /** Path relative to the run directory, which is also the read route's parameter. */
  path: string;
  kind: 'file' | 'directory';
  /** What the workflow says this file is for; empty for a file it never declared. */
  description: string;
  /** The jobs the workflow says write it. */
  producedBy: string[];
  /** True when the workflow's run-directory block names this entry. */
  declared: boolean;
  state: WorkflowArtifactState;
  /** Bytes on disk, absent until the file exists. */
  size?: number;
  /** ISO 8601 of the last write, absent until the file exists. */
  modifiedAt?: string;
}

export interface WorkflowArtifactsResponse {
  /** Absolute path of the run's own directory, which the reader may want to open. */
  runDir: string;
  /** What the workflow says the directory is for. */
  description: string;
  artifacts: WorkflowArtifactView[];
}

/** One artifact's content, as the viewer tab reads it. */
export interface WorkflowArtifactContentResponse {
  path: string;
  size: number;
  modifiedAt: string;
  /** The file's text, truncated to the reader's line budget. */
  text: string;
  /** True when the file was longer than the budget and the head is what came back. */
  truncated: boolean;
}
