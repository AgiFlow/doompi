import { SUBAGENT_ACTIONS } from '@agimon-ai/doompi-extension-contracts/subagent-tool';

const ACTION_SUMMARY = [
  `${SUBAGENT_ACTIONS.agents}: list executable agents or inspect one by name`,
  `${SUBAGENT_ACTIONS.run}: start one or more fresh background runs`,
  `${SUBAGENT_ACTIONS.status}: inspect the fleet or one run`,
  `${SUBAGENT_ACTIONS.steer}: send acknowledged guidance to a Pi run`,
  `${SUBAGENT_ACTIONS.stop}: request idempotent termination`,
  `${SUBAGENT_ACTIONS.suspended}: list suspended work`,
  `${SUBAGENT_ACTIONS.restore}: continue a suspended Pi transcript`,
].join('; ');

export const SUBAGENT_SAFETY_GUIDANCE =
  'Give every child a self-contained task; coordination and further delegation depend on the Team package policy.';

export const SUBAGENT_TOOL_DESCRIPTION = [
  'Run and manage background subagents through one strict action-based contract.',
  'Delegate only independent parallel work, long-running work, or work that materially benefits from a fresh context; handle small direct tasks yourself.',
  `Actions: ${ACTION_SUMMARY}.`,
  'A run call uses requests:[{agent,task,cwd?,model?,runtime?}]. It returns after startup; completion arrives asynchronously.',
  'Fleet status is {action:"status"}. transcriptLines is valid only with an id. Fleet status includes suspended runs and restore instructions.',
  'External CLI runtimes do not support steering or intercom, and Team package tool exclusions are best effort for them.',
  SUBAGENT_SAFETY_GUIDANCE,
].join(' ');
