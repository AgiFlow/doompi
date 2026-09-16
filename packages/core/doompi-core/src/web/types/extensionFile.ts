import type {
  ActivityGroupContribution,
  ContextActionContribution,
  DockFaceContribution,
  LeaderBindingContribution,
  MinorModeContribution,
  PaletteCommandContribution,
  SelectionAxisContribution,
  SessionChannelContribution,
  SettingsPanelContribution,
  SettingsSectionContribution,
  SlotDeclaration,
  SlotFillContribution,
  TabContribution,
  ToolRendererContribution,
  UserMessageActionContribution,
} from './webPlugin';

/**
 * What a folder-routed frontend file may export, per surface.
 *
 * The path-derived keys are optional rather than absent, because the
 * generated entry spreads the authored value over the derived identity: a file
 * that states its own id keeps it. See docs/extension-layout.md for which
 * folder produces which of these.
 *
 * There is no factory form here. The cockpit builds its plugin definition as
 * data and starts it separately, so a frontend contribution has no mount
 * context to receive.
 */

/** The host contract with the keys a path derives made optional. */
export type PathSupplied<TContribution, TKeys extends keyof TContribution> = Omit<TContribution, TKeys> &
  Partial<Pick<TContribution, TKeys>>;

/** `tool/<name>.tsx`. The filename names the tool this renders, in snake case. */
export type ToolRendererFile = PathSupplied<ToolRendererContribution, 'tools'>;

/** `command/<name>.tsx`. The filename becomes the palette command id, in kebab case. */
export type PaletteCommandFile = PathSupplied<PaletteCommandContribution, 'id'>;

/** `tab/<Name>.tsx`. The filename becomes the tab id, in kebab case. */
export type TabFile = PathSupplied<TabContribution, 'id'>;

/** `dock/<Name>.tsx`. The filename becomes the dock face id, in kebab case. */
export type DockFaceFile = PathSupplied<DockFaceContribution, 'id'>;

/** `setting/<name>.tsx` exporting fields. The filename becomes the section id. */
export type SettingsSectionFile = PathSupplied<SettingsSectionContribution, 'id'>;

/** `setting/<name>.tsx` exporting a component. The filename becomes the panel id. */
export type SettingsPanelFile = PathSupplied<SettingsPanelContribution, 'id'>;

/** `slot/<name>.ts`. The slot is namespaced as `<pluginId>.<name>`. */
export type SlotFile<TData = unknown> = PathSupplied<SlotDeclaration<TData>, 'slot'>;

/** `fill/<Name>.<target>.tsx`. The target is the slot; the name becomes the fill id. */
export type FillFile = PathSupplied<SlotFillContribution, 'slot' | 'id'>;

/** `action/<name>.ts` offering an action for a context item kind. */
export type ContextActionFile = PathSupplied<ContextActionContribution, 'id'>;

/** `action/<name>.ts` offering an action on a user timeline message. */
export type UserMessageActionFile = PathSupplied<UserMessageActionContribution, 'id'>;

/** `activity-group/<name>.ts`. The filename is the group name and its slot. */
export type ActivityGroupFile = PathSupplied<ActivityGroupContribution, 'name'>;

/** `selection-axis/<name>.ts`. The filename becomes the axis name. */
export type SelectionAxisFile = PathSupplied<SelectionAxisContribution, 'name'>;

/**
 * `leader/<name>.ts`. The filename is the binding's local name, namespaced
 * under the plugin id, because the key tree is shared across plugins.
 */
export type LeaderBindingFile = LeaderBindingContribution extends infer Binding
  ? Binding extends { id: string }
    ? Omit<Binding, 'id'> & Partial<Pick<Binding, 'id'>>
    : never
  : never;

/** `mode/<name>/mode.ts`. The gate folder names the mode, in kebab case. */
export type MinorModeFile = PathSupplied<MinorModeContribution, 'name'>;

/**
 * `channel/<frameType>.ts`. Usually the result of a session store's `channel`,
 * which already names the frame type, so the derived one is only a default.
 */
export type ChannelFile<TPayload = unknown> = PathSupplied<SessionChannelContribution<TPayload>, 'channel'>;
