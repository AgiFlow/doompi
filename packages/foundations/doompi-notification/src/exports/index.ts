export { createMainThreadTitleController, createWorkerTitleController } from '../services/shellTitleController';
export { sendSystemNotification } from '../services/systemNotification';
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
  NotificationExtensionOptions,
  ShellTitleAction,
  ShellTitleCommand,
  ShellTitleController,
  WriteTitle,
} from '../types/notifications';
