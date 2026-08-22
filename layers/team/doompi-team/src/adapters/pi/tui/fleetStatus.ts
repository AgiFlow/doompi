import type { DoomFooterContributionValue, FooterTextSegment } from '@agimon-ai/doompi-extension-contracts/footer';
import { agentIdentityColor } from '@agimon-ai/doompi-ui/theme';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type TrackedAsyncJobsContract, TERMINAL_ASYNC_JOB_STATES, type TrackedAsyncJob } from '../../asyncJobTracker';
import type { ActivityState } from '../../../types';

export const FLEET_STATUS_KEY = 'doom-team-agents';
export const AGENT_PULSE_FRAMES = ['◐', '●', '◑'] as const;

const FULL_PREFIX = 'Agents ';
const COMPACT_PREFIX = 'A ';
const FULL_TEXT_LIMIT = 80;
const COMPACT_TEXT_LIMIT = 24;
const ATTENTION_GLYPH = '!';
const WAITING_GLYPH = '○';
const COMPLETED_GLYPH = '✓';
const FAILED_GLYPH = '✗';
const STOPPED_GLYPH = '■';
const NEEDS_ATTENTION_STATE: ActivityState = 'needs_attention';
const COMPLETED_JOB_STATES: ReadonlySet<string> = new Set(['complete', 'completed']);
const STOPPED_JOB_STATES: ReadonlySet<string> = new Set(['paused', 'stopped']);
const FAILED_JOB_STATE = 'failed';
const PULSING_ACTIVITY_STATES: ReadonlySet<ActivityState> = new Set([
  'working',
  'tool',
  'finalizing',
  'active_long_running',
]);

export interface AgentFleetStatus {
  text: string;
  footer: DoomFooterContributionValue;
  fingerprint: string;
  pulsing: boolean;
}

interface AgentDot {
  glyph: string;
  color: ReturnType<typeof agentIdentityColor> | 'warning';
}

function stableOffset(value: string): number {
  let hash = 0;
  for (const character of value) hash = (Math.imul(hash, 31) + (character.codePointAt(0) ?? 0)) >>> 0;
  return hash % AGENT_PULSE_FRAMES.length;
}

function activeAgents(tracker: TrackedAsyncJobsContract): TrackedAsyncJob[] {
  return tracker.list().filter((job) => !job.status || !TERMINAL_ASYNC_JOB_STATES.has(job.status));
}

function dotFor(job: TrackedAsyncJob, frame: number): AgentDot {
  const color = agentIdentityColor(job.runId);
  if (job.status && COMPLETED_JOB_STATES.has(job.status)) return { glyph: COMPLETED_GLYPH, color };
  if (job.status === FAILED_JOB_STATE) return { glyph: FAILED_GLYPH, color };
  if (job.status && STOPPED_JOB_STATES.has(job.status)) return { glyph: STOPPED_GLYPH, color };
  if (job.activityState === NEEDS_ATTENTION_STATE) return { glyph: ATTENTION_GLYPH, color: 'warning' };
  if (!job.activityState || !PULSING_ACTIVITY_STATES.has(job.activityState)) return { glyph: WAITING_GLYPH, color };
  return { glyph: AGENT_PULSE_FRAMES[(frame + stableOffset(job.runId)) % AGENT_PULSE_FRAMES.length]!, color };
}

function projectDots(
  jobs: readonly TrackedAsyncJob[],
  dots: readonly AgentDot[],
  prefix: string,
  limit: number,
): { text: string; segments: FooterTextSegment[] } {
  const available = limit - prefix.length;
  let visibleCount = Math.min(jobs.length, available);
  let suffix = '';
  while (visibleCount < jobs.length) {
    suffix = `…+${jobs.length - visibleCount}`;
    if (visibleCount + suffix.length <= available) break;
    visibleCount -= 1;
  }
  const visibleDots = dots.slice(0, Math.max(0, visibleCount));
  const text = `${prefix}${visibleDots.map((dot) => dot.glyph).join('')}${suffix}`;
  return {
    text,
    segments: [
      { text: prefix },
      ...visibleDots.map((dot) => ({ text: dot.glyph, color: dot.color })),
      ...(suffix ? [{ text: suffix, color: 'dim' as const }] : []),
    ],
  };
}

/** Count only work that has not reached a terminal state. */
export function activeAgentCount(tracker: TrackedAsyncJobsContract): number {
  return activeAgents(tracker).length;
}

/** Render one animation frame for both Pi's status and the Doom footer contribution. */
export function agentFleetStatus(tracker: TrackedAsyncJobsContract, frame = 0): AgentFleetStatus | undefined {
  const jobs = tracker.list();
  if (jobs.length === 0) return undefined;
  const dots = jobs.map((job) => dotFor(job, frame));
  const full = projectDots(jobs, dots, FULL_PREFIX, FULL_TEXT_LIMIT);
  const compact = projectDots(jobs, dots, COMPACT_PREFIX, COMPACT_TEXT_LIMIT);
  const pulsing = activeAgents(tracker).some(
    (job) => job.activityState !== undefined && PULSING_ACTIVITY_STATES.has(job.activityState),
  );
  return {
    text: full.text,
    footer: {
      fullText: full.text,
      compactText: compact.text,
      fullSegments: full.segments,
      compactSegments: compact.segments,
    },
    fingerprint: `${jobs.map((job) => `${job.runId}:${job.agent ?? ''}:${job.status ?? ''}:${job.activityState ?? ''}`).join('|')}:${pulsing ? frame : 'static'}`,
    pulsing,
  };
}

/** Compact footer text. An absent value removes the group entirely. */
export function agentStatusText(tracker: TrackedAsyncJobsContract, frame = 0): string | undefined {
  return agentFleetStatus(tracker, frame)?.text;
}

export function publishAgentStatus(
  ctx: ExtensionContext,
  tracker: TrackedAsyncJobsContract,
  frame = 0,
): string | undefined {
  const text = agentStatusText(tracker, frame);
  if (ctx.hasUI) ctx.ui.setStatus(FLEET_STATUS_KEY, text);
  return text;
}
