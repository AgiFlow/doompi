import {
  DOOM_HEADLESS_HOST_SERVICE,
  requireDoomHeadlessHost,
  type DoomHeadlessToolResult,
} from '@agimon-ai/doompi-extension-contracts/headless';
import type { MinorModeOwnerHandle, MinorModeState } from '@agimon-ai/doompi-extension-contracts/mode';
import type { Context } from '@deepseek-ai/cordis';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDoomConfig, resolvePlanningPlansDirectory } from '../../schemas/plan/config.ts';
import { parseDebugEvidencePacket, planTitleSlug } from '../../services/planMode.ts';
import { PLAN_REVIEW_OPTIONS, PLAN_REVIEW_TITLE } from '../../types/planApi.ts';
import { readFile } from 'node:fs/promises';

type HeadlessFacet = {
  inject: readonly string[];
  apply(context: Context): void | (() => void);
};

const RECORD_DEBUG_EVIDENCE_TOOL = 'record_debug_evidence';
const RUN_FABLE_PLAN_TOOL = 'run_fable_plan';
const WRITE_PLAN_TOOL = 'write_plan';
const COMPLETE_PLAN_TOOL = 'complete_plan';
const PLAN_MODE_ID = 'plan';
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

function latestMarkdown(entries: readonly Record<string, unknown>[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    const candidates = [entry.text, entry.content, entry.markdown];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().startsWith('#')) return candidate.trim();
    }
  }
  return undefined;
}

async function skill(): Promise<string> {
  return readFile(new URL('../../prompts/doompi-use-plan/SKILL.md', import.meta.url), 'utf8');
}

export const planHeadlessFacet: HeadlessFacet = {
  inject: [DOOM_HEADLESS_HOST_SERVICE],
  apply(context: Context) {
    const host = requireDoomHeadlessHost(context);
    let flavor: 'normal' | 'debug' | 'fable' = 'normal';
    let modeOwner: MinorModeOwnerHandle | undefined;
    const modeSelected = (): boolean => host.context.selection.minorModes.includes(PLAN_MODE_ID);
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
    const publishMode = (): void => modeOwner?.publish(modeState());
    const selectPlan = async (enabled: boolean, nextFlavor = flavor): Promise<void> => {
      const modes = host.context.selection.minorModes.filter((mode) => mode !== PLAN_MODE_ID);
      await host.select({ minorModes: enabled ? [...modes, PLAN_MODE_ID] : modes });
      flavor = nextFlavor;
      publishMode();
    };
    modeOwner = host.registerMinorMode({
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
      initialState: modeState(),
      async handleAction(actionId, argumentsValue, execution) {
        execution.signal.throwIfAborted();
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
    });
    const toolRestriction = host.registerToolRestriction({
      minorMode: PLAN_MODE_ID,
      allowedTools: PLAN_MODE_ALLOWED_TOOLS,
    });

    const registrations = [
      host.registerResource({
        when: { minorMode: PLAN_MODE_ID },
        name: 'doompi-use-plan',
        kind: 'skill',
        read: () => skill(),
      }),
      host.registerTool({
        when: { minorMode: PLAN_MODE_ID },
        name: RECORD_DEBUG_EVIDENCE_TOOL,
        label: 'Record Debug Evidence',
        description: 'Record bounded debug evidence as optional planning context.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string' },
            reproduction: { type: 'string' },
            logs: { type: 'array', items: { type: 'string' } },
            traces: { type: 'array', items: { type: 'string' } },
            processOutput: { type: 'array', items: { type: 'string' } },
            browserEvidence: { type: 'array', items: { type: 'string' } },
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
      }),
      host.registerTool({
        when: { minorMode: PLAN_MODE_ID },
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
      }),
      host.registerTool({
        when: { minorMode: PLAN_MODE_ID },
        name: WRITE_PLAN_TOOL,
        label: 'Write Plan',
        description: 'Save the implementation plan already presented in the session.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        executionMode: 'serial',
        async execute(_toolCallId, _parameters, signal) {
          try {
            signal?.throwIfAborted();
            let content = latestMarkdown(host.context.session.entries());
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
      }),
      host.registerTool({
        when: { minorMode: PLAN_MODE_ID },
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
      }),
      host.registerHook({
        when: { minorMode: PLAN_MODE_ID },
        event: 'before_agent_start',
        handle(event) {
          const prompt = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
          return {
            systemPrompt:
              `${prompt}\n\n[PLAN MODE ACTIVE]\nRemain read-only and save the complete plan before requesting approval.`.trim(),
          };
        },
      }),
    ];
    return () => {
      toolRestriction.dispose();
      modeOwner?.dispose();
      registrations.forEach((registration) => registration.dispose());
    };
  },
};

export default planHeadlessFacet;
