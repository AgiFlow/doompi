import type {
  ChannelFile,
  ContextActionFile,
  DockFaceFile,
  FillFile,
  MinorModeFile,
  PaletteCommandFile,
  SettingsPanelFile,
  SettingsSectionFile,
  SlotFile,
  TabFile,
  ToolRendererFile,
  UserMessageActionFile,
} from '../web/types/extensionFile';
import type { SessionChannelContribution, SlotDeclaration, WebPluginDefinition } from '../web/types/webPlugin';

/** Identity helper so plugin modules get checked literals without a type annotation. */
export function defineWebPlugin(plugin: WebPluginDefinition): WebPluginDefinition {
  return plugin;
}

/**
 * The one audited erasure from Payload to unknown. Channels are stored
 * untyped in the host registry; the payload type lives entirely inside the
 * plugin, behind its own parse gate.
 */
export function defineSessionChannel<Payload>(
  channel: SessionChannelContribution<Payload>,
): SessionChannelContribution {
  return channel as SessionChannelContribution;
}

/**
 * Identity helper for a typed slot handle: the owner keeps the
 * SlotDeclaration<Data> to read its fills back through slotData, and the
 * plugin's `slots` array holds it erased. No cast is needed because Data only
 * appears in the parse gate's return position.
 */
export function defineSlot<Data>(slot: SlotDeclaration<Data>): SlotDeclaration<Data> {
  return slot;
}

/**
 * Identity helpers for folder-routed frontend files, one per surface.
 *
 * Each returns its argument unchanged. The value is the position they check
 * and the inference they supply, which is otherwise absent: a routed file's
 * default export reaches a contribution array through a generated entry that
 * types it as unknown.
 */

/** `tool/<name>.tsx`. The filename names the tool this renders. */
export function defineToolRenderer(file: ToolRendererFile): ToolRendererFile {
  return file;
}

/** `command/<name>.tsx`. */
export function definePaletteCommand(file: PaletteCommandFile): PaletteCommandFile {
  return file;
}

/** `tab/<Name>.tsx`. */
export function defineTab(file: TabFile): TabFile {
  return file;
}

/** `dock/<Name>.tsx`. */
export function defineDockFace(file: DockFaceFile): DockFaceFile {
  return file;
}

/** `setting/<name>.tsx` declaring fields the host renders. */
export function defineSettingsSection(file: SettingsSectionFile): SettingsSectionFile {
  return file;
}

/** `setting/<name>.tsx` drawing its own page. */
export function defineSettingsPanel(file: SettingsPanelFile): SettingsPanelFile {
  return file;
}

/** `slot/<name>.ts`. The slot is namespaced as `<pluginId>.<name>`. */
export function defineSlotFile<Data = unknown>(file: SlotFile<Data>): SlotFile<Data> {
  return file;
}

/** `fill/<Name>.<target>.tsx`. */
export function defineFill(file: FillFile): FillFile {
  return file;
}

/** `action/<name>.ts` for a context item kind. */
export function defineContextAction(file: ContextActionFile): ContextActionFile {
  return file;
}

/** `action/<name>.ts` for a user timeline message. */
export function defineUserMessageAction(file: UserMessageActionFile): UserMessageActionFile {
  return file;
}

/** `mode/<name>/mode.ts`. */
export function defineMinorModeFile(file: MinorModeFile): MinorModeFile {
  return file;
}

/** `channel/<frameType>.ts`. */
export function defineChannelFile<Payload = unknown>(file: ChannelFile<Payload>): ChannelFile<Payload> {
  return file;
}
