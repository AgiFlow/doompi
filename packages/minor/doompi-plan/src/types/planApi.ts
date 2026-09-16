/**
 * The wire vocabulary this package's API shares with whatever calls it.
 *
 * It lives under src/types because that is the one server root a browser
 * bundle may read: the routes answer with these shapes and the cockpit plugin
 * reads them, so neither half can drift from the other. The paths themselves
 * are not here; they are declared once in `./apiRoutes`, which the Hono app
 * and the generated client both read.
 *
 * Two routes, and neither takes a path. A session has one current plan, so
 * `current` answers it and `content` takes the manual save back; the file they
 * act on is the one write_plan recorded, never one the page named. That is
 * also why there is nothing to escape here: a reader cannot address a second
 * file through these URLs.
 */

/** Where a host mounts this package's API; the segment after /api/plugins/. */
export const API_BASE_PATH = 'plans';

/**
 * Footer status key the session publishes once a plan exists, which is what
 * makes the cockpit's activity group appear at all. It outlives plan mode: the
 * plan is most worth reading while the agent implements it.
 */
export const PLAN_STATUS_KEY = 'doom-plan-document';

/** The selector contract shared by complete_plan and its cockpit composer prompt. */
export const PLAN_REVIEW_TITLE = 'Plan complete. What would you like to do?';
export const EXIT_PLAN_MODE_CHOICE = 'Exit plan mode and start implementation';
export const CONTINUE_PLANNING_CHOICE = 'Continue planning';
export const EXIT_PLAN_DECISION = 'exit';
export const CONTINUE_PLAN_DECISION = 'continue';

/**
 * The label the reader sees paired with the decision the tool acts on. A headless
 * client answers with `value`, so a facet never has to recognise the wording; Pi's
 * own `ui.select` carries labels only, so its half maps the label back itself.
 */
export const PLAN_REVIEW_CHOICES = [
  { label: EXIT_PLAN_MODE_CHOICE, value: EXIT_PLAN_DECISION },
  { label: CONTINUE_PLANNING_CHOICE, value: CONTINUE_PLAN_DECISION },
] as const;

/** The same options as bare labels, which is all Pi's select and the composer prompt need. */
export const PLAN_REVIEW_OPTIONS = PLAN_REVIEW_CHOICES.map((choice) => choice.label);

/** Between the plan's title and the stamp that marks a rewrite. */
const STATUS_SEPARATOR = ' · ';

/** Strips the colour a session may have themed a status with. */
const ANSI = /\[[0-9;]*m/gu;

/** The status line the session publishes; the stamp changes on every write. */
export function formatPlanStatus(title: string, stamp: string): string {
  return `${title}${STATUS_SEPARATOR}${stamp}`;
}

/** What a reader gets out of the status line. */
export interface PlanStatusView {
  title: string;
  /** When the plan was last written, as the session worded it; empty when it said nothing. */
  stamp: string;
}

/**
 * Reading the status line back. Statuses reach a plugin raw, so the colour a
 * session may have added comes off here. A title can itself contain the
 * separator, so the stamp is taken from the last one rather than the first.
 */
export function parsePlanStatus(raw: string | undefined): PlanStatusView | undefined {
  if (raw === undefined) return undefined;
  const text = raw.replace(ANSI, '').trim();
  if (text === '') return undefined;
  const cut = text.lastIndexOf(STATUS_SEPARATOR);
  if (cut === -1) return { title: text, stamp: '' };
  return { title: text.slice(0, cut).trim(), stamp: text.slice(cut + STATUS_SEPARATOR.length).trim() };
}

/**
 * What write_plan recorded about this session's plan.
 *
 * The absolute path is the point of it: the extension resolves the plans
 * directory against the harness root, which no other process knows, so it
 * writes down where the plan landed rather than leaving the API to derive a
 * location it would sometimes get wrong.
 */
export interface PlanPointerRecord {
  path: string;
  title: string;
  writtenAt: string;
  planId?: string;
}

/** The plan as it stands on disk right now, which is what the source view edits. */
export interface PlanDetailView {
  path: string;
  title: string;
  writtenAt: string;
  planId?: string;
  content: string;
  /** sha256 of the content; the token a save hands back to prove it is not stale. */
  hash: string;
  /** True when the plan is missing or past the size cap, so `content` is empty. */
  unavailable: boolean;
  reason?: string;
}

/** What the save route takes. */
export interface PlanSaveRequest {
  /** The hash the reader loaded; a mismatch means the plan moved underneath them. */
  expectedHash: string;
  content: string;
}

/** What the save route answers with. */
export interface PlanSaveView {
  hash: string;
}

/** What a route reports when it refuses; the page shows `error` verbatim. */
export interface PlanErrorView {
  error: string;
  /** On a stale save, the hash the plan actually has now. */
  hash?: string;
}
