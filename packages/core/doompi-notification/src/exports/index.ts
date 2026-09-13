export type { NotificationExtensionOptions } from '../controllers/notificationRuntime';
export { createMainThreadTitleController, createWorkerTitleController } from '../controllers/shellTitleController';
export { sendSystemNotification } from '../controllers/systemNotification';
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
