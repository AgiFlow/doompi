/** The browser-only status that carries active Loop instances into the activity dock. */
export const LOOP_VIEW_STATUS_KEY = 'doom-loop-instances';

export type LoopStatusState = 'starting' | 'running' | 'stopping';

/** The small, serializable Loop view the cockpit needs for one activity row. */
export interface LoopStatusItem {
  readonly instanceId: string;
  readonly label: string;
  readonly detail: string;
  readonly state: LoopStatusState;
}

interface LoopStatusSource {
  readonly instanceId: string;
  readonly launcherLabel: string;
  readonly label?: string;
  readonly detail?: string;
  readonly state: LoopStatusState;
}

const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*m`, 'gu');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isState(value: unknown): value is LoopStatusState {
  return value === 'starting' || value === 'running' || value === 'stopping';
}

/** Projects runtime snapshots into the JSON status consumed by the web plugin. */
export function formatLoopStatusView(instances: readonly LoopStatusSource[]): string | undefined {
  if (instances.length === 0) return undefined;
  return JSON.stringify(
    instances.map((instance) => ({
      instanceId: instance.instanceId,
      label: instance.label ?? instance.launcherLabel,
      detail: instance.detail ?? instance.instanceId,
      state: instance.state,
    })),
  );
}

/** Reads a Loop status without letting malformed session data crash the activity dock. */
export function parseLoopStatusView(raw: string | undefined): LoopStatusItem[] | undefined {
  if (raw === undefined) return undefined;
  const text = raw.replace(ANSI, '').trim();
  if (text === '') return undefined;

  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const items: LoopStatusItem[] = [];
    for (const item of value) {
      if (
        !isRecord(item) ||
        typeof item.instanceId !== 'string' ||
        item.instanceId.trim() === '' ||
        typeof item.label !== 'string' ||
        item.label.trim() === '' ||
        typeof item.detail !== 'string' ||
        !isState(item.state)
      ) {
        return undefined;
      }
      items.push({ instanceId: item.instanceId, label: item.label, detail: item.detail, state: item.state });
    }
    return items;
  } catch {
    return undefined;
  }
}
