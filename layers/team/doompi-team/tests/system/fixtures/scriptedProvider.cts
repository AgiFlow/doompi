import * as fs from 'node:fs';
import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const EXPLICIT_SKILL_NAME = 'explicit-system-skill';
const EXPLICIT_SKILL_DESCRIPTION = 'Explicit system skill metadata description';
const EXPLICIT_SKILL_BODY = 'EXPLICIT_SKILL_BODY_E2E_OK';
const AMBIENT_SKILL_NAME = 'ambient-system-skill';
const GUARDRAIL_TOOL_CALL_ID = 'guardrail-yarn';
const EXPLICIT_SKILL_READ_CALL_ID = 'explicit-skill-read';

function configuredChildExtensions(): unknown {
  try {
    return JSON.parse(process.env.DOOMPI_CHILD_EXTENSIONS ?? '[]');
  } catch {
    return 'invalid';
  }
}

function childResponse(context: Context): string {
  if (process.env.DOOM_TEAM_SYSTEM_INHERITANCE_TEST !== '1') return 'CHILD_E2E_OK';

  const systemPrompt = context.systemPrompt ?? '';
  return JSON.stringify({
    childExtensions: configuredChildExtensions(),
    domainSkills: process.env.DOOMPI_SKILL_DIRS,
    domains: process.env.DOOMPI_DOMAINS,
    majorMode: process.env.DOOMPI_MAJOR_MODE,
    layers: process.env.DOOMPI_LAYERS,
    personaInherited: systemPrompt.includes('PROFILE_PERSONA_E2E_OK'),
    profile: process.env.DOOMPI_PROFILE,
    profileEnvironment: process.env.DOOM_TEAM_SYSTEM_PROFILE_VALUE,
    skillInherited: systemPrompt.includes('doom-team-system-skill'),
    tools: context.tools?.map((tool) => tool.name) ?? [],
  });
}

function toolResults(context: Context): Array<Record<string, unknown>> {
  return context.messages.filter((message) => message.role === 'toolResult') as unknown as Array<
    Record<string, unknown>
  >;
}

function toolResult(context: Context, toolCallId: string): Record<string, unknown> | undefined {
  return toolResults(context).find((result) => result.toolCallId === toolCallId);
}

function guardrailChildContent(context: Context) {
  const result = toolResult(context, GUARDRAIL_TOOL_CALL_ID);
  if (!result) {
    return [
      {
        type: 'toolCall' as const,
        id: GUARDRAIL_TOOL_CALL_ID,
        name: 'bash',
        arguments: { command: 'yarn --version' },
      },
    ];
  }

  const childExtensions = configuredChildExtensions();
  const extensionPaths = Array.isArray(childExtensions)
    ? childExtensions.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const resultEvidence = JSON.stringify(result);
  const guardrailsInherited = extensionPaths.some((entry) => entry.endsWith('consumer-guardrail.mjs'));
  const vibeLintInherited = extensionPaths.some((entry) => entry.includes('/vibe-lint/'));
  const yarnBlocked = resultEvidence.includes('Use an Nx target instead of Yarn');
  const sentinel =
    guardrailsInherited && vibeLintInherited && yarnBlocked
      ? 'CHILD_GUARDRAIL_BLOCKED_E2E_OK'
      : 'CHILD_GUARDRAIL_BLOCKED_E2E_FAILED';
  return [
    {
      type: 'text' as const,
      text: `${sentinel} ${JSON.stringify({ childExtensions, guardrailsInherited, result, vibeLintInherited, yarnBlocked })}`,
    },
  ];
}

function explicitSkillChildContent(context: Context) {
  const systemPrompt = context.systemPrompt ?? '';
  const location = systemPrompt.match(/<location>([^<]+)<\/location>/)?.[1];
  const result = toolResult(context, EXPLICIT_SKILL_READ_CALL_ID);
  if (!result && location) {
    return [
      {
        type: 'toolCall' as const,
        id: EXPLICIT_SKILL_READ_CALL_ID,
        name: 'read',
        arguments: { path: location },
      },
    ];
  }

  const resultEvidence = JSON.stringify(result ?? {});
  const tools = context.tools?.map((tool) => tool.name) ?? [];
  const evidence = {
    ambientListed: systemPrompt.includes(AMBIENT_SKILL_NAME),
    ambientSkillsDisabled: process.env.PI_SUBAGENT_INHERIT_SKILLS === '0',
    bodyInjected: systemPrompt.includes(EXPLICIT_SKILL_BODY),
    descriptionPresent: systemPrompt.includes(EXPLICIT_SKILL_DESCRIPTION),
    location,
    namePresent: systemPrompt.includes(`<name>${EXPLICIT_SKILL_NAME}</name>`),
    readActive: tools.includes('read'),
    readBodyPresent: resultEvidence.includes(EXPLICIT_SKILL_BODY),
    readResult: result,
    tools,
  };
  const succeeded =
    !evidence.ambientListed &&
    evidence.ambientSkillsDisabled &&
    !evidence.bodyInjected &&
    evidence.descriptionPresent &&
    Boolean(evidence.location) &&
    evidence.namePresent &&
    evidence.readActive &&
    evidence.readBodyPresent;
  return [
    {
      type: 'text' as const,
      text: `${succeeded ? 'CHILD_EXPLICIT_SKILL_E2E_OK' : 'CHILD_EXPLICIT_SKILL_E2E_FAILED'} ${JSON.stringify(evidence)}`,
    },
  ];
}

function spawnedRunId(context: Context): string | undefined {
  const first = toolResults(context)[0];
  const details = first?.details as { spawn?: { outcomes?: Array<{ runId?: string }> } } | undefined;
  return details?.spawn?.outcomes?.[0]?.runId;
}

function steerContent(context: Context, isChild: boolean) {
  const results = toolResults(context);
  if (isChild) {
    if (results.length === 0) {
      return [
        {
          type: 'toolCall' as const,
          id: 'steer-pause',
          name: 'system_pause',
          arguments: { milliseconds: 1_000 },
        },
      ];
    }
    return [{ type: 'text' as const, text: 'CHILD_STEER_E2E_OK' }];
  }
  const runId = spawnedRunId(context);
  if (results.length === 0) {
    return [
      {
        type: 'toolCall' as const,
        id: 'steer-spawn',
        name: 'subagent',
        arguments: { action: 'run', requests: [{ agent: 'system-worker', task: 'Wait for live guidance.' }] },
      },
    ];
  }
  if (!runId) return [{ type: 'text' as const, text: 'STEER_MISSING_RUN_ID' }];
  if (results.length === 1) {
    return [
      {
        type: 'toolCall' as const,
        id: 'steer-request',
        name: 'subagent',
        arguments: { action: 'steer', id: runId, message: 'STEER_INSTRUCTION_E2E_OK' },
      },
    ];
  }
  return [{ type: 'text' as const, text: `STEER_E2E_OK ${JSON.stringify(results[1])}` }];
}

function teamChildContent(context: Context) {
  const childIndex = Number.parseInt(process.env.PI_SUBAGENT_CHILD_INDEX ?? '0', 10);
  if (childIndex === 0) {
    if (!toolResult(context, 'team-initiator-pause')) {
      return [
        {
          type: 'toolCall' as const,
          id: 'team-initiator-pause',
          name: 'system_pause',
          arguments: { milliseconds: 400 },
        },
      ];
    }
    const membersResult = toolResult(context, 'team-members');
    if (!membersResult) {
      return [
        {
          type: 'toolCall' as const,
          id: 'team-members',
          name: 'intercom',
          arguments: { action: 'members' },
        },
      ];
    }
    const selfId = process.env.PI_SUBAGENT_TEAM_MEMBER_ID;
    const target = (
      membersResult.details as { members?: Array<{ name?: string; role?: string }> } | undefined
    )?.members?.find((member) => member.role === 'subagent' && member.name !== selfId)?.name;
    if (!target) return [{ type: 'text' as const, text: 'TEAM_TARGET_MISSING' }];
    if (!toolResult(context, 'team-send')) {
      return [
        {
          type: 'toolCall' as const,
          id: 'team-send',
          name: 'intercom',
          arguments: { action: 'send', to: target, message: 'TEAM_SEND_E2E_OK' },
        },
      ];
    }
    if (!toolResult(context, 'team-ask')) {
      return [
        {
          type: 'toolCall' as const,
          id: 'team-ask',
          name: 'intercom',
          arguments: { action: 'ask', to: target, message: 'TEAM_ASK_E2E_OK', timeoutMs: 10_000 },
        },
      ];
    }
    return [
      {
        type: 'text' as const,
        text: `TEAM_INITIATOR_E2E_OK ${JSON.stringify(toolResult(context, 'team-ask'))}`,
      },
    ];
  }

  if (!toolResult(context, 'team-responder-pause')) {
    return [
      {
        type: 'toolCall' as const,
        id: 'team-responder-pause',
        name: 'system_pause',
        arguments: { milliseconds: 800 },
      },
    ];
  }
  const pending = toolResult(context, 'team-pending');
  if (!pending) {
    return [
      {
        type: 'toolCall' as const,
        id: 'team-pending',
        name: 'intercom',
        arguments: { action: 'pending' },
      },
    ];
  }
  const requestId = (pending.details as { pending?: Array<{ id?: string }> } | undefined)?.pending?.[0]?.id;
  if (!requestId) {
    return [
      {
        type: 'toolCall' as const,
        id: 'team-retry-pause',
        name: 'system_pause',
        arguments: { milliseconds: 250 },
      },
    ];
  }
  if (!toolResult(context, 'team-reply')) {
    return [
      {
        type: 'toolCall' as const,
        id: 'team-reply',
        name: 'intercom',
        arguments: { action: 'reply', requestId, message: 'TEAM_REPLY_E2E_OK' },
      },
    ];
  }
  return [
    {
      type: 'text' as const,
      text: `TEAM_RESPONDER_E2E_OK ${JSON.stringify(toolResults(context))}`,
    },
  ];
}

function teamParentContent(context: Context) {
  const results = toolResults(context);
  if (results.length === 0) {
    return [
      {
        type: 'toolCall' as const,
        id: 'team-spawn',
        name: 'subagent',
        arguments: {
          action: 'run',
          requests: [
            { agent: 'system-worker', task: 'Send and ask the other worker.' },
            { agent: 'system-worker', task: 'Reply to the other worker.' },
          ],
        },
      },
    ];
  }
  return [{ type: 'text' as const, text: `TEAM_PARENT_E2E_OK ${JSON.stringify(results)}` }];
}

function sigkillContent(context: Context, isChild: boolean) {
  const results = toolResults(context);
  if (isChild) {
    if (results.length === 0) {
      return [
        {
          type: 'toolCall' as const,
          id: 'sigkill-pause',
          name: 'system_pause',
          arguments: { milliseconds: 10_000 },
        },
      ];
    }
    return [{ type: 'text' as const, text: 'SIGKILL_CHILD_SHOULD_NOT_COMPLETE' }];
  }
  if (results.length === 0) {
    return [
      {
        type: 'toolCall' as const,
        id: 'sigkill-spawn',
        name: 'subagent',
        arguments: { action: 'run', requests: [{ agent: 'system-worker', task: 'Remain active until killed.' }] },
      },
    ];
  }
  return [{ type: 'text' as const, text: `SIGKILL_PARENT_E2E_OK ${JSON.stringify(results)}` }];
}

function recordDeliverableTurn(): void {
  const markerPath = process.env.DOOM_TEAM_SYSTEM_DELIVERABLE_MARKER;
  if (!markerPath) return;
  let prior = 0;
  try {
    prior = Number.parseInt(fs.readFileSync(markerPath, 'utf8'), 10) || 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The first turn creates the marker.
  }
  fs.writeFileSync(markerPath, `${prior + 1}\n`);
}

function deliverableContent(context: Context, isChild: boolean) {
  const results = toolResults(context);
  if (isChild) {
    recordDeliverableTurn();
    return [{ type: 'text' as const, text: '' }];
  }
  if (results.length === 0) {
    return [
      {
        type: 'toolCall' as const,
        id: 'deliverable-spawn',
        name: 'subagent',
        arguments: {
          action: 'run',
          requests: [
            { agent: 'system-worker', task: 'Implement the requested code change and provide a completion summary.' },
          ],
        },
      },
    ];
  }
  return [{ type: 'text' as const, text: `DELIVERABLE_PARENT_E2E_OK ${JSON.stringify(results)}` }];
}

function scriptedStream(model: Model<Api>, context: Context, _options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const isChild = process.env.PI_SUBAGENT_CHILD === '1';
    const results = toolResults(context);
    const hasToolResult = results.length > 0;
    const scenario = process.env.DOOM_TEAM_SYSTEM_SCENARIO;
    const content =
      scenario === 'sigkill'
        ? sigkillContent(context, isChild)
        : scenario === 'deliverable'
          ? deliverableContent(context, isChild)
          : scenario === 'team'
            ? isChild
              ? teamChildContent(context)
              : teamParentContent(context)
            : scenario === 'steer'
              ? steerContent(context, isChild)
              : isChild
                ? scenario === 'guardrails'
                  ? guardrailChildContent(context)
                  : scenario === 'explicit-skill'
                    ? explicitSkillChildContent(context)
                    : [{ type: 'text' as const, text: childResponse(context) }]
                : hasToolResult
                  ? [{ type: 'text' as const, text: 'PARENT_E2E_OK' }]
                  : [
                      {
                        type: 'toolCall' as const,
                        id: 'system-subagent-call',
                        name: 'subagent',
                        arguments: {
                          action: 'run',
                          requests: [{ agent: 'system-worker', task: 'Return exactly CHILD_E2E_OK.' }],
                          artifacts: true,
                        },
                      },
                    ];
    const stopReason: 'stop' | 'toolUse' = content.some((item) => item.type === 'toolCall') ? 'toolUse' : 'stop';
    const message: AssistantMessage = {
      role: 'assistant',
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason,
      timestamp: Date.now(),
    };
    stream.push({ type: 'start', partial: { ...message, content: [] } });
    stream.push({ type: 'done', reason: stopReason, message });
    stream.end();
  });
  return stream;
}

export function registerScriptedProvider(pi: ExtensionAPI): void {
  pi.registerCommand('system-reload', {
    description: 'Reload the real Pi extension runtime for the Doom Team system test.',
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  pi.registerTool({
    name: 'system_pause',
    label: 'System Pause',
    description: 'Pause briefly so the system test can steer an active child.',
    parameters: Type.Object({ milliseconds: Type.Integer({ minimum: 1, maximum: 15_000 }) }),
    async execute(_id, params) {
      await new Promise<void>((resolve) => setTimeout(resolve, params.milliseconds));
      return { content: [{ type: 'text', text: 'SYSTEM_PAUSE_COMPLETE' }], details: {} };
    },
  });
  pi.registerProvider('scripted', {
    name: 'Doom Team System Test',
    baseUrl: 'http://127.0.0.1.invalid',
    apiKey: 'system-test',
    api: 'openai-completions',
    streamSimple: scriptedStream,
    models: [
      {
        id: 'system-test',
        name: 'System Test',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_384,
        maxTokens: 1_024,
      },
    ],
  });
}
