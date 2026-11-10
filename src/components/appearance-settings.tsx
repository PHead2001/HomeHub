'use client';

import { useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { Monitor, Moon, Palette, Play, Sun } from 'lucide-react';
import { useAppearance } from '@/components/appearance-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { canVibrate, playFeedback } from '@/lib/feedback';
import { TEXT_SCALES, parseTextScale, type TextScale } from '@/lib/theme/appearance';
import {
  DARK_PRESET_IDS,
  LIGHT_PRESET_IDS,
  PRESETS,
  isDarkPresetId,
  isLightPresetId,
  isThemeMode,
  type PresetId,
  type ThemeMode,
} from '@/lib/theme/tokens';
import { cn } from '@/lib/utils';

const noopSubscribe = () => () => undefined;

const MODES: Array<{ value: ThemeMode; label: string; icon: typeof Moon }> = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
];

// The tile glyph grows with the step; the whole page (and the preview) shows the real size.
const TEXT_SIZES: Record<TextScale, { label: string; glyph: string }> = {
  100: { label: 'Default', glyph: 'text-base' },
  115: { label: 'Large', glyph: 'text-lg' },
  130: { label: 'Larger', glyph: 'text-xl' },
};

const optionClass =
  'flex cursor-pointer items-center gap-3 rounded-lg border bg-background/60 p-3 transition-colors hover:bg-accent has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/10';

function Swatch({ id }: { id: PresetId }) {
  const { colors } = PRESETS[id];
  // Colors come straight from the preset tokens.
  return (
    <span aria-hidden className="flex shrink-0 overflow-hidden rounded-full border" style={{ borderColor: `hsl(${colors.border})` }}>
      <span className="h-6 w-3" style={{ background: `hsl(${colors.background})` }} />
      <span className="h-6 w-3" style={{ background: `hsl(${colors.card})` }} />
      <span className="h-6 w-3" style={{ background: `hsl(${colors.primary})` }} />
    </span>
  );
}

function PresetGroup({
  label,
  ids,
  value,
  active,
  onChange,
}: {
  label: string;
  ids: readonly PresetId[];
  value: PresetId;
  active: boolean;
  onChange: (id: string, origin: HTMLElement | null) => void;
}) {
  const groupId = `preset-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div className="space-y-2">
      <p id={groupId} className="text-sm font-medium">
        {label}
        {active && <span className="ml-2 text-xs font-normal text-muted-foreground">In use</span>}
      </p>
      <RadioGroup aria-labelledby={groupId} value={value} onValueChange={(id) => onChange(id, document.getElementById(`${groupId}-${id}`))}>
        {ids.map((id) => (
          <Label key={id} htmlFor={`${groupId}-${id}`} className={optionClass}>
            <RadioGroupItem id={`${groupId}-${id}`} value={id} />
            <Swatch id={id} />
            <span className="min-w-0">
              <span className="block font-medium">{PRESETS[id].label}</span>
              <span className="block text-xs font-normal text-muted-foreground">{PRESETS[id].description}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
    </div>
  );
}

/** Profile → Appearance: theme mode, presets, text size, reduce motion, sound and haptics. */
export function AppearanceSettings() {
  const { preferences, activePreset, systemReducedMotion, setPreferences } = useAppearance();
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  // Haptics are offered only where navigator.vibrate exists (false during SSR).
  const vibrationSupported = useSyncExternalStore(noopSubscribe, canVibrate, () => false);

  const rememberPointer = (event: ReactPointerEvent) => {
    lastPointer.current = { x: event.clientX, y: event.clientY };
  };
  // Reveal from where the member clicked, or from the focused control for keyboard changes.
  const takeOrigin = (fallback: HTMLElement | null) => {
    const origin = lastPointer.current ?? fallback;
    lastPointer.current = null;
    return origin;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-headline flex items-center gap-2">
          <Palette /> Appearance
        </CardTitle>
        <CardDescription>
          Theme, text size, motion and feedback. Theme and motion follow you to other devices; text size stays on this one.
        </CardDescription>
      </CardHeader>
      <CardContent
        className="space-y-6"
        onPointerDownCapture={rememberPointer}
        onKeyDownCapture={() => {
          lastPointer.current = null;
        }}
      >
        <div className="space-y-2">
          <p id="appearance-mode" className="text-sm font-medium">Theme</p>
          <RadioGroup
            aria-labelledby="appearance-mode"
            value={preferences.mode}
            onValueChange={(mode) => {
              if (isThemeMode(mode)) setPreferences({ mode }, takeOrigin(document.getElementById(`appearance-mode-${mode}`)));
            }}
            className="grid-cols-3"
          >
            {MODES.map(({ value, label, icon: Icon }) => (
              <Label
                key={value}
                htmlFor={`appearance-mode-${value}`}
                className={cn(
                  optionClass,
                  'flex-col gap-1.5 px-2 py-3 text-center',
                  // The radio itself is visually hidden, so its focus ring shows on the tile.
                  'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                )}
              >
                <RadioGroupItem id={`appearance-mode-${value}`} value={value} className="sr-only" />
                <Icon className="h-5 w-5" aria-hidden />
                <span>{label}</span>
              </Label>
            ))}
          </RadioGroup>
          {preferences.mode === 'system' && (
            <p className="text-xs text-muted-foreground">Follows your device: dark and light use the themes below.</p>
          )}
        </div>

        <PresetGroup
          label="Dark theme"
          ids={DARK_PRESET_IDS}
          value={preferences.darkPreset}
          active={activePreset === preferences.darkPreset}
          onChange={(id, el) => {
            if (isDarkPresetId(id)) setPreferences({ darkPreset: id }, takeOrigin(el));
          }}
        />
        <PresetGroup
          label="Light theme"
          ids={LIGHT_PRESET_IDS}
          value={preferences.lightPreset}
          active={activePreset === preferences.lightPreset}
          onChange={(id, el) => {
            if (isLightPresetId(id)) setPreferences({ lightPreset: id }, takeOrigin(el));
          }}
        />

        <div className="space-y-2">
          <p id="appearance-text-size" className="text-sm font-medium">
            Text size
            <span className="ml-2 text-xs font-normal text-muted-foreground">This device only</span>
          </p>
          <RadioGroup
            aria-labelledby="appearance-text-size"
            aria-describedby="appearance-text-size-preview"
            value={String(preferences.textScale)}
            onValueChange={(value) => setPreferences({ textScale: parseTextScale(value) })}
            className="grid-cols-3"
          >
            {TEXT_SCALES.map((scale) => (
              <Label
                key={scale}
                htmlFor={`appearance-text-size-${scale}`}
                className={cn(
                  optionClass,
                  'flex-col gap-1 px-2 py-3 text-center',
                  'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                )}
              >
                <RadioGroupItem id={`appearance-text-size-${scale}`} value={String(scale)} className="sr-only" />
                <span aria-hidden className={cn('font-headline font-semibold leading-none', TEXT_SIZES[scale].glyph)}>Aa</span>
                <span>{TEXT_SIZES[scale].label}</span>
                <span className="text-xs font-normal text-muted-foreground">{scale}%</span>
              </Label>
            ))}
          </RadioGroup>
          {/* Live preview: the setting applies to the whole page at once, this sample included. */}
          <div id="appearance-text-size-preview" className="rounded-lg border bg-background/60 p-3" aria-live="polite">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview at {preferences.textScale}%</p>
            <p className="mt-1 font-medium">Take out the recycling</p>
            <p className="text-sm text-muted-foreground">Due today · Kitchen</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="appearance-reduce-motion" className="text-base">Reduce motion</Label>
              <p className="text-xs text-muted-foreground">
                {systemReducedMotion
                  ? 'Your device already asks for reduced motion, so animations are off.'
                  : 'Show end states instantly: no transitions, drifting or counting.'}
              </p>
            </div>
            <Switch
              id="appearance-reduce-motion"
              checked={preferences.reduceMotion || systemReducedMotion}
              disabled={systemReducedMotion}
              onCheckedChange={(reduceMotion) => setPreferences({ reduceMotion })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="appearance-sound" className="text-base">Sound effects</Label>
              <p className="text-xs text-muted-foreground">Soft sounds when you finish or add something. This device only.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Play a sample sound"
                onClick={() => playFeedback('complete', { force: 'sound' })}
              >
                <Play />
              </Button>
              <Switch id="appearance-sound" checked={preferences.sound} onCheckedChange={(sound) => setPreferences({ sound })} />
            </div>
          </div>

          {vibrationSupported && (
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="appearance-haptics" className="text-base">Haptics</Label>
                <p className="text-xs text-muted-foreground">A light buzz when you finish or add something. This device only.</p>
              </div>
              <Switch
                id="appearance-haptics"
                checked={preferences.haptics}
                onCheckedChange={(haptics) => {
                  setPreferences({ haptics });
                  if (haptics) playFeedback('add', { force: 'haptics' });
                }}
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
