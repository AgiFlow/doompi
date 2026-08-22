export { autoStopExtension } from '../adapters/pi/extension.ts';
export { registerIdleShutdown } from '../adapters/pi/idleShutdown.ts';
export {
  AUTO_STOP_ACTION,
  type AutoStopAction,
  type AutoStopDecision,
  type AutoStopDelays,
  DEFAULT_AUTO_STOP_DELAYS,
  decideOnRecheck,
  decideOnSettled,
  type SessionActivity,
} from '../services/idlePolicy.ts';
