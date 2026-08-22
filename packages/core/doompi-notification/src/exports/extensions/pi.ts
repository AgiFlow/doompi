// Pi loads the module's default export as its host entry contract, so the
// manifest-facing facade aliases the already named factory.
export { notificationExtension as default, notificationExtension } from '../../adapters/pi/extension.ts';
