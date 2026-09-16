import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type DoomHeadlessHostService, type DoomHeadlessModelSettings } from '@agimon-ai/doompi-core/headless';
import { type DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import { type DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';
import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import { defineMinorMode, type MinorModeOwner, type MinorModeState } from '@agimon-ai/doompi-minor-mode';

import { loadDoomConfig, resolvePlanningPlansDirectory } from '../../schemas/plan/config';
import {
  buildFlavorPlanningPrompt,
  buildPlanModeBasePrompt,
  type DebugEvidencePacket,
  type PlanningFlavor,
  readPlanSkill,
} from '../../services/prompts';
import {
  CONTINUE_PLAN_DECISION,
  EXIT_PLAN_DECISION,
  PLAN_REVIEW_CHOICES,
  PLAN_REVIEW_TITLE,
} from '../../types/planApi';
import {
  parseDebugEvidencePacket,
  PLAN_CONTINUE_TEXT,
  PLAN_EXIT_APPROVED_TEXT,
  planTitleSlug,
  visiblePlanForToolCall,
} from '../planMode';

const RECORD_DEBUG_EVIDENCE_TOOL = 'record_debug_evidence';
const RUN_FABLE_PLAN_TOOL = 'run_fable_plan';
const WRITE_PLAN_TOOL = 'write_plan';
const COMPLETE_PLAN_TOOL = 'complete_plan';
const PLAN_MODE_ID = 'plan';
const PLAN_MODEL_SNAPSHOT = 'plan-server-model-snapshot';
const PLAN_FLAVOR_SNAPSHOT = 'plan-server-flavor';
const PLAN_DEBUG_EVIDENCE = 'plan-debug-evidence';
const PLAN_DOCUMENT = 'plan-document';
/**
 * Fable needs a broker this host does not have, so `run_fable_plan` is a stub here. The stage is
 * reported honestly rather than as an idle run that is about to start.
 */
const PLAN_SERVER_FABLE_STAGE = 'unavailable';
const PLAN_MODE_ALLOWED_TOOLS = [
  'add_directory',
  'ask_user_question',
  'bash',
  COMPLETE_PLAN_TOOL,
  'describe_author_tools',
  'describe_voice_tools',
  'find',
  'grep',
  'intercom',
  'ls',
  'minor_mode',
  'mcp',
  'narrate',
  'open_authoring_file',
  'read',
  RECORD_DEBUG_EVIDENCE_TOOL,
  RUN_FABLE_PLAN_TOOL,
  'search_external_files',
  'subagent',
  'subagent_supervisor',
  'subagent_wait',
  'task',
  'transfer_voice',
  'use_author_tools',
  'use_voice_tools',
  WRITE_PLAN_TOOL,
] as const;
function output(value: unknown, isError = false): DoomHeadlessToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    details: value,
    ...(isError ? { isError: true } : {}),
  };
}

export function createPlanServerSession(
  host: DoomHeadlessHostService,
): Omit<DoomServerSessionPlugin, 'tools'> & { tools: Parameters<DoomHeadlessHostService['registerTool']>[0][] } {
  let flavor: PlanningFlavor = 'normal';
  let debugEvidence: DebugEvidencePacket | undefined;
  let modeOwner: MinorModeOwner | undefined;
  const modeSelected = (): boolean => (host.context.selection.state?.['minor-mode'] ?? []).includes(PLAN_MODE_ID);
  const homeDirectory = (): string => host.context.environment.HOME ?? os.homedir();
  // One resolution for the prompt and for write_plan. They named different directories before,
  // so the prompt could advertise a path the tool would not write to.
  const plansDirectory = (): string =>
    resolvePlanningPlansDirectory(
      loadDoomConfig(host.context.repoRoot, homeDirectory()).modes?.planning?.plansDirectory,
      host.context.repoRoot,
      homeDirectory(),
    );
  const modeState = (): MinorModeState => {
    const active = modeSelected();
    return {
      activation: active ? 'active' : 'inactive',
      condition: 'ready',
      ...(active ? { detail: `${flavor} - read only`, modelContextVariant: flavor } : {}),
      actions: [
        {
          id: 'activate',
          enabled: true,
        },
        {
          id: 'deactivate',
          enabled: active,
          ...(active ? {} : { disabledReason: 'Plan mode is inactive.' }),
        },
      ],
    };
  };
  const publishMode = (): void => modeOwner?.publish();
  const restoreModel = async (): Promise<void> => {
    const session = host.context.session;
    const entries = await session.entries({ type: 'custom', customType: PLAN_MODEL_SNAPSHOT, limit: 1 });
    const data = entries[0]?.data;
    if (data === undefined || data === null) return;
    if (
      typeof data !== 'object' ||
      !('thinkingLevel' in data) ||
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(data.thinkingLevel))
    )
      throw new Error('The saved planning model settings are invalid.');
    if (!session.setModelSettings) throw new Error('This session cannot restore its model settings.');
    await session.setModelSettings(data as DoomHeadlessModelSettings);
    await session.appendCustomEntry(PLAN_MODEL_SNAPSHOT, null);
  };
  const selectPlan = async (enabled: boolean, nextFlavor = flavor): Promise<void> => {
    const wasEnabled = modeSelected();
    const session = host.context.session;
    if (enabled && !wasEnabled) {
      const config = loadDoomConfig(host.context.repoRoot, homeDirectory()).modes?.planning?.main;
      if (config?.model || config?.thinking) {
        if (!session.readModelSettings || !session.setModelSettings)
          throw new Error('This session cannot apply planning model settings.');
        const previous = await session.readModelSettings();
        const settings: Partial<DoomHeadlessModelSettings> = {};
        if (config.model) {
          const separator = config.model.indexOf('/');
          const provider = separator > 0 ? config.model.slice(0, separator) : previous.model?.provider;
          if (!provider) throw new Error('The planning model needs a provider.');
          settings.model = { provider, id: separator > 0 ? config.model.slice(separator + 1) : config.model };
        }
        if (config.thinking) settings.thinkingLevel = config.thinking;
        await session.appendCustomEntry(PLAN_MODEL_SNAPSHOT, previous);
        try {
          await session.setModelSettings(settings);
        } catch (error) {
          await session.setModelSettings(previous);
          await session.appendCustomEntry(PLAN_MODEL_SNAPSHOT, null);
          throw error;
        }
      }
    } else if (!enabled && wasEnabled) {
      await restoreModel();
    }
    const modes = (host.context.selection.state?.['minor-mode'] ?? []).filter((mode) => mode !== PLAN_MODE_ID);
    await host.changeSelection({
      axis: 'state',
      key: 'minor-mode',
      values: enabled ? [...modes, PLAN_MODE_ID] : modes,
    });
    flavor = nextFlavor;
    // Persisted because the minor mode survives a server restart while this local does not, and
    // the prompt is built from it. Without this a restored debug session silently plans as normal.
    await session.appendCustomEntry(PLAN_FLAVOR_SNAPSHOT, enabled ? { flavor } : null);
    publishMode();
  };

  /** Newest value for a custom entry type, or undefined when none was recorded. */
  const latestEntry = async (customType: string): Promise<unknown> => {
    const entries = await host.context.session.entries({ type: 'custom', customType, limit: 1 });
    return entries[0]?.data ?? undefined;
  };

  const restorePlanState = async (): Promise<void> => {
    const saved = await latestEntry(PLAN_FLAVOR_SNAPSHOT);
    if (saved !== undefined && saved !== null && typeof saved === 'object' && 'flavor' in saved) {
      const candidate = String((saved as { flavor: unknown }).flavor);
      if (candidate === 'normal' || candidate === 'debug' || candidate === 'fable') flavor = candidate;
    }
    const evidence = await latestEntry(PLAN_DEBUG_EVIDENCE);
    if (evidence === undefined || evidence === null) return;
    try {
      debugEvidence = parseDebugEvidencePacket(evidence);
    } catch {
      // A packet written by an older shape must not stop the session from planning.
      debugEvidence = undefined;
    }
  };
  modeOwner = defineMinorMode({
    descriptor: {
      source: '@agimon-ai/doompi-plan',
      id: PLAN_MODE_ID,
      label: 'Plan',
      description: 'Read-only planning with normal, debug, and Fable flavors.',
      order: 40,
      actions: [
        {
          id: 'activate',
          label: 'Activate',
          description: 'Activate plan mode or switch its planning flavor.',
          contexts: ['headless'],
          parameters: [
            {
              name: 'flavor',
              label: 'Flavor',
              kind: 'enum',
              required: true,
              choices: [
                { value: 'normal', label: 'Normal' },
                { value: 'debug', label: 'Debug' },
                { value: 'fable', label: 'Fable' },
              ],
            },
          ],
        },
        {
          id: 'deactivate',
          label: 'Deactivate',
          description: 'Exit plan mode and restore the previous agent configuration.',
          contexts: ['headless'],
          parameters: [],
        },
      ],
    },
    state: () => modeState(),
    async handleAction(_runtime, actionId, argumentsValue, { signal }) {
      signal.throwIfAborted();
      if (actionId === 'activate') {
        const nextFlavor = argumentsValue.flavor;
        if (nextFlavor !== 'normal' && nextFlavor !== 'debug' && nextFlavor !== 'fable')
          throw new Error('A valid plan flavor is required.');
        await selectPlan(true, nextFlavor);
        return { message: `Plan mode is active with the ${nextFlavor} flavor.` };
      }
      if (actionId === 'deactivate') {
        await selectPlan(false);
        return { message: 'Plan mode deactivated.' };
      }
      throw new Error(`Unknown plan mode action: ${actionId}`);
    },
  }).createOwner(undefined);
  return {
    services: [serverMinorModes([modeOwner])],
    toolRestrictions: [
      {
        when: { state: { 'minor-mode': PLAN_MODE_ID } },
        allowedTools: PLAN_MODE_ALLOWED_TOOLS,
      },
    ],
    resources: [
      {
        when: { state: { 'minor-mode': PLAN_MODE_ID }, attribution: { kind: 'minor', mode: PLAN_MODE_ID } },
        name: 'doompi-use-plan',
        kind: 'skill',
        read: () => readPlanSkill(),
      },
    ],
    tools: [
      {
        when: { state: { 'minor-mode': PLAN_MODE_ID }, attribution: { kind: 'minor', mode: PLAN_MODE_ID } },
        name: RECORD_DEBUG_EVIDENCE_TOOL,
        label: 'Record Debug Evidence',
        description: 'Record bounded debug evidence as optional planning context.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string' },
            expectedBehavior: { type: 'string' },
            reproductionAttempt: { type: 'string' },
            actualBehavior: { type: 'string' },
            logs: { type: 'array', items: { type: 'string' } },
            correlatedTraceEvidence: { type: 'array', items: { type: 'string' } },
            processOutput: { type: 'array', items: { type: 'string' } },
            browserConsoleEvidence: { type: 'array', items: { type: 'string' } },
            correlationIds: { type: 'array', items: { type: 'string' } },
            timestamps: { type: 'array', items: { type: 'string' } },
            verifiedFacts: { type: 'array', items: { type: 'string' } },
            hypotheses: { type: 'array', items: { type: 'string' } },
            unavailableEvidence: { type: 'array', items: { type: 'string' } },
          },
          required: ['issue'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute(_toolCallId, parameters) {
          try {
            const parsedEvidence = parseDebugEvidencePacket(parameters);
            await host.context.session.appendCustomEntry(PLAN_DEBUG_EVIDENCE, parsedEvidence);
            // Held in memory too: the debug prompt is rebuilt every turn from this packet.
            debugEvidence = parsedEvidence;
            return output({ recorded: true });
          } catch (error) {
            return output(error instanceof Error ? error.message : String(error), true);
          }
        },
      },
      {
        when: { state: { 'minor-mode': PLAN_MODE_ID }, attribution: { kind: 'minor', mode: PLAN_MODE_ID } },
        name: RUN_FABLE_PLAN_TOOL,
        label: 'Run Fable Plan',
        description: 'Run the configured local Fable planning broker with bounded evidence.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'array', items: { type: 'string' } },
            constraints: { type: 'array', items: { type: 'string' } },
          },
          required: ['goal'],
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute() {
          return output(
            'Fable planning is unavailable in the headless host because no broker seam is configured.',
            true,
          );
        },
      },
      {
        when: { state: { 'minor-mode': PLAN_MODE_ID }, attribution: { kind: 'minor', mode: PLAN_MODE_ID } },
        name: WRITE_PLAN_TOOL,
        label: 'Write Plan',
        description: 'Save the implementation plan already presented in the session.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        executionMode: 'serial',
        async execute(toolCallId, _parameters, signal) {
          try {
            signal?.throwIfAborted();
            // Same extraction the Pi path uses: the text this very tool call was
            // introduced by, not "the last assistant message that looks like a heading".
            let content = visiblePlanForToolCall(await host.context.session.entries(), toolCallId);
            if (content === undefined) {
              const requested = await host.context.client.request(
                {
                  kind: 'input',
                  title: 'Implementation plan',
                  multiline: true,
                },
                signal,
              );
              content = typeof requested === 'string' ? requested : '';
            }
            if (!content.trim()) throw new Error('No implementation plan content was supplied.');
            const directory = plansDirectory();
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const filename = `${planTitleSlug(content)}-${Date.now()}.md`;
            const filePath = path.join(directory, filename);
            await writeFile(filePath, `${content.trim()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await host.context.session.appendCustomEntry(PLAN_DOCUMENT, { path: filePath, content: content.trim() });
            await selectPlan(true);
            return output({ path: filePath, written: true });
          } catch (error) {
            return output(error instanceof Error ? error.message : String(error), true);
          }
        },
      },
      {
        when: { state: { 'minor-mode': PLAN_MODE_ID }, attribution: { kind: 'minor', mode: PLAN_MODE_ID } },
        name: COMPLETE_PLAN_TOOL,
        label: 'Complete Plan',
        description: 'Ask the user for explicit exit-or-continue approval for the saved implementation plan.',
        // No decision parameter: this facet has no narrated review to answer, so a model-supplied
        // decision would be the agent approving its own plan instead of the reader approving it.
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        executionMode: 'serial',
        async execute(_toolCallId, _parameters, signal) {
          try {
            // The client answers with the option's `value`, so the decision travels with the
            // question instead of the facet having to recognise the label it rendered.
            const decision = await host.context.client.request(
              {
                kind: 'select',
                title: PLAN_REVIEW_TITLE,
                options: PLAN_REVIEW_CHOICES.map((choice) => ({ ...choice })),
              },
              signal,
            );
            // A dismissed or aborted prompt answers with nothing, and that is not approval.
            const exited = decision === EXIT_PLAN_DECISION;
            await host.context.session.appendCustomEntry('plan-review', {
              decision: exited ? EXIT_PLAN_DECISION : CONTINUE_PLAN_DECISION,
            });
            await selectPlan(!exited);
            return {
              content: [{ type: 'text', text: exited ? PLAN_EXIT_APPROVED_TEXT : PLAN_CONTINUE_TEXT }],
              details: { exited },
            };
          } catch (error) {
            return output(error instanceof Error ? error.message : String(error), true);
          }
        },
      },
    ],
    hooks: [
      {
        when: { state: { 'minor-mode': PLAN_MODE_ID }, attribution: { kind: 'minor', mode: PLAN_MODE_ID } },
        event: 'before_agent_start',
        async handle(event) {
          const prompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
          const directory = plansDirectory();
          const sections = [
            buildPlanModeBasePrompt(directory),
            buildFlavorPlanningPrompt(flavor, directory, debugEvidence, PLAN_SERVER_FABLE_STAGE),
          ];
          const saved = await latestEntry(PLAN_DOCUMENT);
          if (saved !== undefined && saved !== null && typeof saved === 'object' && 'path' in saved) {
            const document = saved as { path: string; content?: string };
            // Read from disk rather than from what write_plan remembered: the plan is editable in
            // the cockpit, and a reader who corrected it expects that correction implemented.
            let content = document.content ?? '';
            try {
              content = await readFile(document.path, 'utf8');
            } catch {
              content = document.content ?? '';
            }
            if (content.trim()) sections.push(`[CURRENT PLAN]\nSource: ${document.path}\n\n${content}`);
          }
          return { systemPrompt: `${prompt}\n\n${sections.join('\n\n')}`.trim() };
        },
      },
      {
        event: 'session_start',
        async handle() {
          await restorePlanState();
          // Restore a saved model override if Plan was not restored with the session.
          if (!modeSelected()) await restoreModel();
        },
      },
    ],
  };
}
