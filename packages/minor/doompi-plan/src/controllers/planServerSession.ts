import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type DoomHeadlessHostService, type DoomHeadlessModelSettings } from '@agimon-ai/doompi-core/headless';
import { type DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import { type DoomServerSessionPlugin } from '@agimon-ai/doompi-core/server-facet';
import { serverMinorModes } from '@agimon-ai/doompi-minor-mode';
import { defineMinorMode, type MinorModeOwner, type MinorModeState } from '@agimon-ai/doompi-minor-mode';

import { loadDoomConfig, resolvePlanningPlansDirectory } from '../schemas/plan/config';
import { readPlanSkill } from '../services/prompts';
import { PLAN_REVIEW_OPTIONS, PLAN_REVIEW_TITLE } from '../types/planApi';
import { parseDebugEvidencePacket, planTitleSlug, visiblePlanForToolCall } from './planMode';

const RECORD_DEBUG_EVIDENCE_TOOL = 'record_debug_evidence';
const RUN_FABLE_PLAN_TOOL = 'run_fable_plan';
const WRITE_PLAN_TOOL = 'write_plan';
const COMPLETE_PLAN_TOOL = 'complete_plan';
const PLAN_MODE_ID = 'plan';
const PLAN_MODEL_SNAPSHOT = 'plan-server-model-snapshot';
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
  let flavor: 'normal' | 'debug' | 'fable' = 'normal';
  let modeOwner: MinorModeOwner | undefined;
  const modeSelected = (): boolean => (host.context.selection.state?.['minor-mode'] ?? []).includes(PLAN_MODE_ID);
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
      const config = loadDoomConfig(host.context.repoRoot, host.context.environment.HOME ?? os.homedir()).modes
        ?.planning?.main;
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
    publishMode();
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
            await host.context.session.appendCustomEntry('plan-debug-evidence', parsedEvidence);
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
            const config = loadDoomConfig(host.context.cwd);
            const directory = resolvePlanningPlansDirectory(
              config.modes?.planning?.plansDirectory,
              host.context.cwd,
              os.homedir(),
            );
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const filename = `${planTitleSlug(content)}-${Date.now()}.md`;
            const filePath = path.join(directory, filename);
            await writeFile(filePath, `${content.trim()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await host.context.session.appendCustomEntry('plan-document', { path: filePath, content: content.trim() });
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
        description: 'Ask for explicit exit-or-continue approval for the saved implementation plan.',
        parameters: {
          type: 'object',
          properties: { decision: { type: 'string', enum: ['exit', 'continue'] } },
          additionalProperties: false,
        },
        executionMode: 'serial',
        async execute(_toolCallId, parameters, signal) {
          try {
            const raw = (parameters as { decision?: unknown }).decision;
            const decision =
              raw === 'exit' || raw === 'continue'
                ? raw
                : String(
                    await host.context.client.request(
                      {
                        kind: 'select',
                        title: PLAN_REVIEW_TITLE,
                        options: PLAN_REVIEW_OPTIONS.map((option) => ({ label: option, value: option })),
                      },
                      signal,
                    ),
                  );
            if (decision !== 'exit' && decision !== 'continue') throw new Error('Choose exit or continue.');
            await host.context.session.appendCustomEntry('plan-review', { decision });
            await selectPlan(decision === 'continue');
            return output({ decision, exited: decision === 'exit' });
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
        handle(event) {
          const prompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
          return {
            systemPrompt:
              `${prompt}\n\n[PLAN MODE ACTIVE]\nRemain read-only and save the complete plan before requesting approval.`.trim(),
          };
        },
      },
      {
        event: 'session_start',
        async handle() {
          // Restore a saved model override if Plan was not restored with the session.
          if (!modeSelected()) await restoreModel();
        },
      },
    ],
  };
}
