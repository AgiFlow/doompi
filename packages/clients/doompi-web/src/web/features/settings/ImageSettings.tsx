import { Button, Input, Switch } from '@agimon-ai/doompi-web-components';
import { useEffect, useState } from 'react';
import { readImageSettings, writeImageSettings } from '../../lib/settingsApi.ts';
import type { SettingsImagesView } from '../../../types/settings.ts';
import { SettingsSectionHeader } from './SettingsSectionHeader.tsx';

/**
 * The image page: how large an image may be when it reaches a model.
 *
 * These two write Pi's own settings.json rather than the Doom config, because
 * Pi's terminal settings screen writes the same toggle and a machine should not
 * hold two answers. The toggle applies at once; the cap is typed, so it saves
 * on its own button rather than on every keystroke.
 */
export function ImageSettings() {
  const [images, setImages] = useState<SettingsImagesView | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const adopt = (next: SettingsImagesView): void => {
    setImages(next);
    setDraft(String(next.maxDimension));
  };

  useEffect(() => {
    let cancelled = false;
    void readImageSettings().then((result) => {
      if (cancelled) return;
      if (result.ok) adopt(result.images);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (change: { autoResize?: boolean; maxDimension?: number }): Promise<void> => {
    setBusy(true);
    const result = await writeImageSettings(change);
    setBusy(false);
    if (result.ok) {
      adopt(result.images);
      setError(undefined);
      return;
    }
    setError(result.error);
  };

  const parsed = Number.parseInt(draft, 10);
  const dirty = images !== undefined && Number.isFinite(parsed) && parsed !== images.maxDimension;

  return (
    <div data-testid="image-settings" className="flex flex-col gap-4">
      <SettingsSectionHeader
        title="images"
        detail="how large an image may be when it reaches a model. applies to images the agent reads and to the ones you attach here; Pi's own settings screen writes the same file."
      />
      {error === undefined ? null : (
        <p data-testid="image-settings-error" className="text-[11px] text-doom-red">
          {error}
        </p>
      )}
      {images === undefined ? (
        <p className="text-[11px] text-doom-dim">reading the machine's image settings…</p>
      ) : (
        <div className="flex flex-col gap-3 rounded border border-doom-border bg-doom-panel p-3">
          <label className="flex items-center gap-3">
            <Switch
              data-testid="image-auto-resize"
              checked={images.autoResize}
              disabled={busy}
              onCheckedChange={(checked) => void save({ autoResize: checked })}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-[11px] font-bold text-doom-hi">auto-resize images</span>
              <span className="text-[9px] leading-relaxed text-doom-faint">
                off sends every image at the size it arrived, which a provider may reject for the whole conversation.
              </span>
            </span>
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-bold text-doom-hi">longest edge</span>
            <div className="flex items-center gap-2">
              <Input
                data-testid="image-max-dimension"
                value={draft}
                inputMode="numeric"
                spellCheck={false}
                disabled={busy || !images.autoResize}
                onChange={(event) => setDraft(event.target.value)}
                className="w-28 text-[11px]"
              />
              <Button
                size="sm"
                data-testid="image-max-dimension-save"
                disabled={busy || !dirty}
                onClick={() => void save({ maxDimension: parsed })}
              >
                save
              </Button>
            </div>
            <span className="text-[9px] leading-relaxed text-doom-faint">
              pixels, between {images.minDimension} and {images.maxAllowedDimension}. a value outside that range is
              clamped, because Pi resizes every tool result at {images.maxAllowedDimension} whatever this says.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
