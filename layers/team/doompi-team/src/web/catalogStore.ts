import { defineSessionStore } from '@agimon-ai/doompi-web-contracts';
import {
  SUBAGENT_CATALOG_TYPE,
  type SubagentCatalogAgent,
  type SubagentCatalogPayload,
} from '../types/webSubagents.ts';

/** One session's catalog: what the hub last reported plus what the drawer is doing with it. */
export interface CatalogSession {
  cwd: string;
  agents: SubagentCatalogAgent[];
  models: string[];
  warning: string | undefined;
  /** True while the catalog drawer is shown in the subagents tab. */
  open: boolean;
  filter: string;
  /** The highlighted row, by agent name. */
  selected: string | undefined;
  /** The row whose resources are unfolded. */
  inspected: string | undefined;
  /** The agent the launch dialog is open for, and the context it opened with. */
  launch: { agent: string; fork: boolean } | undefined;
}

export const catalog = defineSessionStore<CatalogSession>({
  cwd: '',
  agents: [],
  models: [],
  warning: undefined,
  open: false,
  filter: '',
  selected: undefined,
  inspected: undefined,
  launch: undefined,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function openCatalog(sessionId: string): void {
  catalog.update(sessionId, (current) => ({ ...current, open: true }));
}

export function closeCatalog(sessionId: string): void {
  catalog.update(sessionId, (current) => ({ ...current, open: false, launch: undefined }));
}

export function setCatalogFilter(sessionId: string, filter: string): void {
  catalog.update(sessionId, (current) => ({ ...current, filter }));
}

export function selectAgent(sessionId: string, name: string | undefined): void {
  catalog.update(sessionId, (current) => ({ ...current, selected: name }));
}

export function toggleInspect(sessionId: string, name: string): void {
  catalog.update(sessionId, (current) => ({ ...current, inspected: current.inspected === name ? undefined : name }));
}

export function openLaunch(sessionId: string, agent: string, fork: boolean): void {
  catalog.update(sessionId, (current) => ({ ...current, selected: agent, launch: { agent, fork } }));
}

export function closeLaunch(sessionId: string): void {
  catalog.update(sessionId, (current) => ({ ...current, launch: undefined }));
}

/** The plugin's catalog channel: 'subagent_catalog' payloads into the store; the drawer's own state survives a refresh. */
export const subagentCatalogChannel = catalog.channel<SubagentCatalogPayload>({
  channel: SUBAGENT_CATALOG_TYPE,
  parse(input) {
    if (!isRecord(input) || typeof input.cwd !== 'string' || !Array.isArray(input.agents)) return null;
    const models = Array.isArray(input.models) ? input.models.filter((m): m is string => typeof m === 'string') : [];
    return {
      cwd: input.cwd,
      agents: input.agents.filter(isRecord) as unknown as SubagentCatalogAgent[],
      models,
      ...(typeof input.warning === 'string' ? { warning: input.warning } : {}),
    };
  },
  reduce(current, payload) {
    const names = new Set(payload.agents.map((agent) => agent.name));
    return {
      ...current,
      cwd: payload.cwd,
      agents: payload.agents,
      models: payload.models,
      warning: payload.warning,
      selected: current.selected !== undefined && names.has(current.selected) ? current.selected : undefined,
      inspected: current.inspected !== undefined && names.has(current.inspected) ? current.inspected : undefined,
    };
  },
});
