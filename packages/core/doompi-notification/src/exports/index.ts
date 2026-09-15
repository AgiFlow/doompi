export type { NotificationExtensionOptions } from '../extensions/workspaces/sessions/(backend)/_lib/notificationRuntime';
export { createMainThreadTitleController, createWorkerTitleController } from '../extensions/workspaces/sessions/(backend)/_lib/shellTitleController';
export { sendSystemNotification } from '../extensions/workspaces/sessions/(backend)/_lib/systemNotification';
export {
  askUserPromptBody,
  type AttentionState,
  type ShellSurface,
  supportsShellTitle,
  warrantsAttentionNotification,
  warrantsSettledNotification,
} from '../services/notificationPolicy';
export {
  attentionNotification,
  notificationBody,
  promptTitle,
  settledNotification,
  shellTabTitle,
  type ShellTabTitleInput,
} from '../services/notificationText';
export type {
  DesktopNotification,
  ShellTitleAction,
  ShellTitleCommand,
  ShellTitleController,
  WriteTitle,
} from '../types/notifications';
