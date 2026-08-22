export { notificationExtension, type NotificationExtensionOptions } from '../adapters/pi/extension.ts';
export { createMainThreadTitleController, createWorkerTitleController } from '../adapters/shellTitleController.ts';
export { sendSystemNotification } from '../adapters/systemNotification.ts';
export {
  askUserPromptBody,
  type AttentionState,
  type ShellSurface,
  supportsShellTitle,
  warrantsAttentionNotification,
  warrantsSettledNotification,
} from '../services/notificationPolicy.ts';
export {
  attentionNotification,
  notificationBody,
  promptTitle,
  settledNotification,
  shellTabTitle,
  type ShellTabTitleInput,
} from '../services/notificationText.ts';
export type {
  DesktopNotification,
  ShellTitleAction,
  ShellTitleCommand,
  ShellTitleController,
  WriteTitle,
} from '../types/notifications.ts';
