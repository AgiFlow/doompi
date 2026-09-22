import {
  Button,
  RadioGroup,
  RadioGroupCard,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useState } from 'react';

import { webTemplateCatalog } from '../../lib/pluginRegistry';
import { resolveWebTemplate } from '../../lib/templateCatalog';
import {
  configuredTemplate,
  refreshTemplateConfiguration,
  saveTemplateDefault,
  useTemplateConfiguration,
} from '../../stores/templateStore';
import { useWebPluginRegistry } from '../../stores/useWebPluginRegistry';
import { workspacesStore } from '../../stores/workspacesStore';
import { SettingsSectionHeader } from './SettingsSectionHeader';

/** Select only admitted template contributions, and make the config write destination explicit. */
export function TemplateSettings({
  target,
  onTargetChange,
}: {
  target: string;
  onTargetChange: (target: string) => void;
}) {
  useWebPluginRegistry();
  const workspaces = useStore(workspacesStore, (state) => state);
  const workspaceId = target.startsWith('workspace:') ? target.slice('workspace:'.length) : undefined;
  const configuration = useTemplateConfiguration(workspaceId);
  const catalog = webTemplateCatalog(
    workspaceId === undefined ? { scope: 'global' } : { scope: 'workspace', workspaceId },
  );
  const configured = configuredTemplate(configuration);
  const resolved = resolveWebTemplate(catalog.templates, configured);
  const [draft, setDraft] = useState<{ target: string; id: string } | null>(null);
  const choice = draft?.target === target ? draft.id : resolved.template?.id;
  const busy = configuration.saving || configuration.loading;
  const origin = configuration.config?.values['web.template']?.origin ?? 'default';
  const missingWorkspace = workspaceId !== undefined && workspaces.byId[workspaceId] === undefined;
  return (
    <section data-testid="template-settings" className="flex flex-col gap-3">
      <SettingsSectionHeader
        title="template"
        detail="Choose the layout provided by your modes.yaml packages. The default is saved in Doom config, separately from the color theme."
      />
      <Select
        value={target}
        onValueChange={(value) => {
          onTargetChange(value);
          setDraft(null);
        }}
        disabled={configuration.saving}
      >
        <SelectTrigger aria-label="template default scope" data-testid="template-scope">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="global">Global default</SelectItem>
          {workspaces.order.map((id) => (
            <SelectItem key={id} value={`workspace:${id}`}>
              Workspace: {workspaces.byId[id]?.root ?? id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p data-testid="template-origin" className="text-sm text-doom-dim">
        {workspaceId === undefined
          ? 'Saves to ~/.pi/.doom/config.yaml.'
          : `Saves to ${configuration.config?.repoRoot ?? workspaces.byId[workspaceId]?.root ?? workspaceId}/.doom/config.yaml.`}{' '}
        Effective default: {configured ?? 'automatic fallback'} ({origin}).
      </p>
      <RadioGroup
        aria-label="web template"
        value={choice ?? ''}
        onValueChange={(id) => setDraft({ target, id })}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        disabled={busy || missingWorkspace}
      >
        {catalog.templates.map((template) => (
          <RadioGroupCard
            key={template.id}
            value={template.id}
            data-testid={`template-${template.id}`}
            data-selected={choice === template.id}
            className="flex flex-col items-start gap-2 p-4"
          >
            <span className="text-lg font-bold text-doom-hi">{template.label}</span>
            <span className="text-sm text-doom-dim">{template.description}</span>
            <span className="text-xs text-doom-faint">Provided by {template.pluginId}</span>
          </RadioGroupCard>
        ))}
      </RadioGroup>
      {resolved.warning ? <output className="block text-sm text-doom-yellow">{resolved.warning}</output> : null}
      {catalog.diagnostics.map((diagnostic, index) => (
        <output key={`${diagnostic.pluginId}:${index}`} className="block text-sm text-doom-yellow">
          {diagnostic.message}
        </output>
      ))}
      {configuration.error ? (
        <p role="alert" data-testid="template-save-error" className="text-sm text-doom-red">
          {configuration.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="template-save"
          size="sm"
          disabled={busy || missingWorkspace || choice === undefined || configuration.config === undefined}
          onClick={() => {
            if (choice !== undefined)
              void saveTemplateDefault(choice, workspaceId).then((saved) => {
                if (saved) setDraft(null);
              });
          }}
        >
          {configuration.saving ? 'Saving...' : 'Set as default'}
        </Button>
        <Button
          data-testid="template-inherit"
          size="sm"
          variant="ghost"
          disabled={busy || missingWorkspace || configuration.config === undefined}
          onClick={() => {
            void saveTemplateDefault(null, workspaceId).then((saved) => {
              if (saved) setDraft(null);
            });
          }}
        >
          {workspaceId === undefined ? 'Use automatic fallback' : 'Inherit global default'}
        </Button>
        <Button
          data-testid="template-reload"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void refreshTemplateConfiguration(workspaceId);
          }}
        >
          Reload configuration
        </Button>
      </div>
    </section>
  );
}
