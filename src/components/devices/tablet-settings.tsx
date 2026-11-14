'use client';

// Tablet settings (replaces Profile on a tablet, WT-14k; design 14.6, WT-16, D-T2, D-T5).
//
// - Comfort, for anyone at the screen, no PIN (WT-16d): theme, text size, motion, sounds.
//   Saved on the device record (`updateDeviceComfortAction`); the record listener applies
//   them live (WT-13a/b).
// - Room, name, sections, start page and the other record settings behind a fresh owner or
//   admin PIN (WT-16e), with the same form as the Devices list.
// - The protected exits, each behind a fresh owner or admin PIN (WT-16a-c): Remove this
//   tablet, Sign in with a personal account (D-T5: ends the device credential, the record
//   stays and needs a re-pair) and Use a different code. Each is logged and notifies the
//   owners and admins (WT-16f); then this browser's tablet data is cleared.

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { DeviceSettingsDialog } from '@/components/household/device-settings-form';
import { exitTabletAction, updateDeviceComfortAction, updateDeviceSettingsFromTabletAction } from '@/app/devices/actions';
import { deviceRefusalResponse, type DeviceRefusal } from '@/lib/devices/action-policy';
import { TEXT_SCALES } from '@/lib/devices/settings';
import type { DeviceComfort } from '@/lib/devices/types';
import type { SessionEnd } from '@/lib/devices/device-session';
import { whileBusy } from '@/lib/shell/busy';
import { cn } from '@/lib/utils';
import { settingsLayer } from '@/lib/devices/shell-state';
import { useTablet, type TabletActor } from './tablet-context';

type Exit = 'remove' | 'personal-sign-in' | 'new-code';

const EXITS: Array<{ exit: Exit; label: string; confirm: string; end: SessionEnd; destructive?: boolean }> = [
  {
    exit: 'personal-sign-in',
    label: 'Sign in with a personal account',
    confirm: 'This tablet stops being a wall tablet: it is signed out and its household data is cleared from this browser. It stays in Devices as needing a re-pair. Then you can sign in with Google.',
    end: 'personal-sign-in',
  },
  {
    exit: 'new-code',
    label: 'Use a different code',
    confirm: 'This tablet is signed out and its household data is cleared from this browser. It stays in Devices as needing a re-pair; enter a new code to set it up again.',
    end: 'new-code',
  },
  {
    exit: 'remove',
    label: 'Remove this tablet',
    confirm: 'This tablet is removed from the household for good and signed out. To use it again, add it as a new tablet.',
    end: 'removed',
    destructive: true,
  },
];

function Choice<T extends string | number>({ label, value, options, onChange, disabled, testId }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            disabled={disabled}
            onClick={() => option.value !== value && onChange(option.value)}
            className={cn('min-h-12 rounded-xl border px-4 text-base', option.value === value ? 'border-primary bg-primary/15 font-semibold text-primary' : 'border-border bg-card')}
            data-testid={`${testId}-${option.value}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function TabletSettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, householdId, idToken, requestAdmin, endSession, person, prompting } = useTablet();
  const [saving, setSaving] = useState<string | null>(null);
  const [admin, setAdmin] = useState<TabletActor | null>(null);
  const [confirming, setConfirming] = useState<(typeof EXITS)[number] | null>(null);
  const [exiting, setExiting] = useState(false);

  const refuse = (code: DeviceRefusal) => {
    const response = deviceRefusalResponse(code, { name: admin ? person(admin.actorUid)?.name : undefined });
    if (response.kind === 'revoked') return endSession(code === 'household_deleting' ? 'household-deleted' : 'removed');
    toast({ variant: 'destructive', description: response.kind === 'message' ? response.message : "Couldn't save. Try again." });
  };

  const saveComfort = async (patch: Partial<DeviceComfort>) => {
    const field = Object.keys(patch)[0];
    setSaving(field);
    try {
      const result = await whileBusy('save', async () => updateDeviceComfortAction({ idToken: await idToken(), householdId, comfort: patch }));
      if (!result.ok) refuse(result.code);
    } catch {
      refuse('unavailable');
    } finally {
      setSaving(null);
    }
  };

  const openAdmin = async () => {
    const actor = await requestAdmin("Change this tablet's room, name, sections or start page.");
    if (actor) setAdmin(actor);
  };

  /** Admin settings: a fresh PIN at the moment of saving (sessions older than 30 s are refused, S9). */
  const saveAdmin = async (patch: Record<string, unknown>): Promise<string | null> => {
    if (!admin) return 'An owner or admin PIN is needed.';
    const send = async (actor: TabletActor) => updateDeviceSettingsFromTabletAction({ idToken: await idToken(), householdId, actorUid: actor.actorUid, pinSessionId: actor.pinSessionId ?? '', patch });
    const fresh = await requestAdmin("Save this tablet's settings.", admin.actorUid);
    if (!fresh) return 'Not saved: the PIN was not entered.';
    let result = await whileBusy('save', send(fresh));
    if (!result.ok && result.code === 'pin_fresh_required') {
      const again = await requestAdmin("Save this tablet's settings.", admin.actorUid);
      if (!again) return 'Not saved: the PIN was not entered.';
      result = await whileBusy('save', send(again));
    }
    if (result.ok) {
      toast({ description: 'Tablet settings saved.' });
      return null;
    }
    const response = deviceRefusalResponse(result.code, { name: person(admin.actorUid)?.name });
    if (response.kind === 'revoked') {
      endSession('removed');
      return null;
    }
    return response.kind === 'message' ? response.message : "Couldn't save. Try again.";
  };

  const runExit = async (choice: (typeof EXITS)[number]) => {
    setConfirming(null);
    const actor = await requestAdmin(`${choice.label}.`);
    if (!actor) return;
    setExiting(true);
    try {
      const result = await whileBusy('save', async () => exitTabletAction({ idToken: await idToken(), householdId, actorUid: actor.actorUid, pinSessionId: actor.pinSessionId ?? '', exit: choice.exit }));
      if (result.ok) {
        endSession(choice.end);
        return;
      }
      refuse(result.code);
    } catch {
      refuse('unavailable');
    } finally {
      setExiting(false);
    }
  };

  const layer = settingsLayer({ admin: admin !== null, confirming: confirming !== null, prompting });
  if (layer === 'hidden') return null;
  if (admin) {
    return (
      <DeviceSettingsDialog
        householdId={householdId}
        deviceName={settings.name}
        settings={settings}
        onClose={() => { setAdmin(null); onClose(); }}
        onSave={saveAdmin}
      />
    );
  }

  const comfort = settings.comfort;
  const busy = saving !== null || exiting;

  return (
    <>
      <Dialog open={layer === 'main'} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
        <DialogContent className="max-h-[calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px))] max-w-2xl overflow-y-auto" data-testid="tablet-settings">
          <DialogHeader>
            <DialogTitle className="font-headline text-2xl">Tablet settings</DialogTitle>
            <DialogDescription>{settings.name}{settings.room ? ` · ${settings.room}` : ''}</DialogDescription>
          </DialogHeader>

          <section className="space-y-4" aria-labelledby="tablet-comfort-title">
            <h2 id="tablet-comfort-title" className="font-headline text-lg font-semibold">Comfort</h2>
            <p className="text-sm text-muted-foreground">Anyone at the tablet can change these.</p>
            <Choice label="Theme" value={comfort.theme} disabled={busy} testId="tablet-theme" onChange={(theme) => void saveComfort({ theme })}
              options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
            <Choice label="Text size" value={comfort.textScale} disabled={busy} testId="tablet-text" onChange={(textScale) => void saveComfort({ textScale })}
              options={TEXT_SCALES.map((scale) => ({ value: scale, label: `${scale}%` }))} />
            <Choice label="Motion" value={comfort.motion} disabled={busy} testId="tablet-motion" onChange={(motion) => void saveComfort({ motion })}
              options={[{ value: 'system', label: 'System' }, { value: 'reduced', label: 'Reduced' }, { value: 'full', label: 'Full' }]} />
            <div className="flex min-h-12 items-center justify-between gap-4">
              <Label htmlFor="tablet-sound" className="text-sm font-medium">Sounds</Label>
              <Switch id="tablet-sound" checked={comfort.sound} disabled={busy} onCheckedChange={(sound) => void saveComfort({ sound })} data-testid="tablet-sound" />
            </div>
            <div aria-live="polite" className="min-h-5 text-xs text-muted-foreground">{saving ? 'Saving…' : ''}</div>
          </section>

          <section className="space-y-3 border-t border-border pt-4" aria-labelledby="tablet-admin-title">
            <h2 id="tablet-admin-title" className="font-headline text-lg font-semibold">Owner or admin</h2>
            <p className="text-sm text-muted-foreground">These need an owner&apos;s or admin&apos;s PIN.</p>
            <Button type="button" variant="outline" className="min-h-12 w-full justify-start" disabled={busy} onClick={() => void openAdmin()} data-testid="tablet-admin-settings">
              Room, name, sections and start page
            </Button>
            {EXITS.map((choice) => (
              <Button
                key={choice.exit}
                type="button"
                variant={choice.destructive ? 'destructive' : 'outline'}
                className="min-h-12 w-full justify-start"
                disabled={busy}
                onClick={() => setConfirming(choice)}
                data-testid={`tablet-exit-${choice.exit}`}
              >
                {exiting ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : null}
                {choice.label}
              </Button>
            ))}
            <p className="text-xs text-muted-foreground">
              Clearing this browser&apos;s data or uninstalling the app also signs the tablet out; it then shows as offline in Devices and needs a new code.
            </p>
          </section>

          <DialogFooter>
            <Button type="button" variant="ghost" className="min-h-12" onClick={onClose} disabled={busy}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {layer === 'confirm' && confirming && (
        <Dialog open onOpenChange={(open) => { if (!open) setConfirming(null); }}>
          <DialogContent className="max-w-lg" data-testid="tablet-exit-confirm">
            <DialogHeader>
              <DialogTitle className="font-headline text-xl">{confirming.label}?</DialogTitle>
              <DialogDescription>{confirming.confirm}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" className="min-h-12" onClick={() => setConfirming(null)}>Cancel</Button>
              <Button type="button" variant={confirming.destructive ? 'destructive' : 'default'} className="min-h-12" onClick={() => void runExit(confirming)} data-testid="tablet-exit-continue">
                Continue with an owner or admin PIN
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
