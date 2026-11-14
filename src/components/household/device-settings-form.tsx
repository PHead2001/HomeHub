'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import {
  DEVICE_NAME_MAX,
  DEVICE_ROOM_MAX,
  DEVICE_SECTION_LABELS,
  WEATHER_PLACE_MAX,
  startPageSection,
  validateDevicePatch,
} from '@/lib/devices/settings';
import { DEVICE_SECTIONS, type DeviceSettings, type DeviceStartPage } from '@/lib/devices/types';

// Editing a tablet's settings from the Devices list (owners and admins). The form
// sends only the fields the person changed, so an edit made meanwhile by someone else
// to another field is kept (the server writes named fields only). Validation is the
// shared pure module the server applies again (src/lib/devices/settings.ts).

type Option = { id: string; name: string };

const IDLE_HOME_OPTIONS = [30, 60, 120, 300, 600, 1800];
const IDLE_AMBIENT_OPTIONS = [60, 120, 300, 600, 1200, 1800, 3600, 7200];

const durationLabel = (seconds: number) => (seconds < 60 ? `${seconds} seconds` : seconds < 3600
  ? `${seconds / 60} ${seconds === 60 ? 'minute' : 'minutes'}`
  : `${seconds / 3600} ${seconds === 3600 ? 'hour' : 'hours'}`);

const startPageKey = (page: DeviceStartPage) =>
  page.kind === 'chores-room' ? `chores-room:${page.roomId}` : page.kind === 'shopping-list' ? `shopping-list:${page.listId}` : page.kind;

const startPageFromKey = (key: string): DeviceStartPage => {
  if (key.startsWith('chores-room:')) return { kind: 'chores-room', roomId: key.slice('chores-room:'.length) };
  if (key.startsWith('shopping-list:')) return { kind: 'shopping-list', listId: key.slice('shopping-list:'.length) };
  return { kind: key as 'home' };
};

/** The fields of `draft` that differ from `initial`, as a patch. */
const diffPatch = (initial: DeviceSettings, draft: DeviceSettings): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (initial.name !== draft.name) patch.name = draft.name;
  if (initial.room !== draft.room) patch.room = draft.room;
  if (!same(initial.startPage, draft.startPage)) patch.startPage = draft.startPage;
  if (initial.camera !== draft.camera) patch.camera = draft.camera;
  for (const group of ['sections', 'comfort', 'display', 'idle'] as const) {
    const before = initial[group] as Record<string, unknown>;
    const after = draft[group] as Record<string, unknown>;
    const changed = Object.fromEntries(Object.keys(after).filter(key => !same(before[key], after[key])).map(key => [key, after[key]]));
    if (Object.keys(changed).length > 0) patch[group] = changed;
  }
  return patch;
};

export function DeviceSettingsDialog({
  householdId,
  deviceName,
  settings,
  onClose,
  onSave,
}: {
  householdId: string;
  deviceName: string;
  settings: DeviceSettings | null;
  onClose: () => void;
  /** Sends the patch; resolves to an error message, or null when saved. */
  onSave: (patch: Record<string, unknown>) => Promise<string | null>;
}) {
  // The form starts from the settings it was opened with (the parent remounts it per
  // tablet); only the fields changed here are sent.
  const [draft, setDraft] = useState<DeviceSettings | null>(settings);
  const [initial] = useState<DeviceSettings | null>(settings);
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [rooms, setRooms] = useState<Option[]>([]);
  const [lists, setLists] = useState<Option[]>([]);

  // Rooms and shopping lists for the start page (best effort: without them the
  // section-wide start pages remain).
  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    void Promise.all([import('@/lib/firebase'), import('firebase/firestore')]).then(async ([{ db }, { collection, getDocs }]) => {
      const read = async (name: string) => {
        try {
          const snapshot = await getDocs(collection(db, 'households', householdId, name));
          return snapshot.docs.map(d => ({ id: d.id, name: String(d.get('name') ?? d.id) })).sort((a, b) => a.name.localeCompare(b.name));
        } catch {
          return [];
        }
      };
      const [roomOptions, listOptions] = await Promise.all([read('rooms'), read('shopping-lists')]);
      if (cancelled) return;
      setRooms(roomOptions);
      setLists(listOptions);
    });
    return () => { cancelled = true; };
  }, [householdId, settings]);

  const patch = useMemo(() => (initial && draft ? diffPatch(initial, draft) : {}), [draft, initial]);
  const dirty = Object.keys(patch).length > 0;
  // Unsaved edits hold the shell busy: no idle return or automatic reload discards them.
  useUnsavedInput(dirty);

  if (!draft || !initial) return null;
  const update = (next: Partial<DeviceSettings>) => {
    setDraft({ ...draft, ...next });
    setError(null);
  };
  const fieldError = (field: string) => (error && (error.field === field || error.field.startsWith(`${field}.`)) ? error.message : null);

  const startPages: Array<{ key: string; label: string; page: DeviceStartPage }> = [
    { key: 'home', label: 'Home', page: { kind: 'home' } },
    { key: 'chores', label: 'Chores', page: { kind: 'chores' } },
    ...rooms.map(room => ({ key: `chores-room:${room.id}`, label: `Chores: ${room.name}`, page: { kind: 'chores-room', roomId: room.id } as DeviceStartPage })),
    { key: 'shopping', label: 'Shopping', page: { kind: 'shopping' } },
    ...lists.map(list => ({ key: `shopping-list:${list.id}`, label: `Shopping list: ${list.name}`, page: { kind: 'shopping-list', listId: list.id } as DeviceStartPage })),
    { key: 'pets', label: 'Pets', page: { kind: 'pets' } },
    { key: 'calendar', label: 'Calendar', page: { kind: 'calendar' } },
    { key: 'maintenance', label: 'Maintenance', page: { kind: 'maintenance' } },
  ];
  const currentKey = startPageKey(draft.startPage);
  if (!startPages.some(option => option.key === currentKey)) startPages.push({ key: currentKey, label: 'Current start page', page: draft.startPage });
  const offerable = startPages.filter(option => {
    const section = startPageSection(option.page);
    return !section || draft.sections[section] || option.key === currentKey;
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || saving) return;
    const checked = validateDevicePatch(patch, initial, 'admin');
    if (!checked.ok) {
      setError({ field: checked.field, message: checked.message });
      return;
    }
    setSaving(true);
    try {
      const message = await onSave(patch);
      if (message) setError({ field: 'form', message });
      else onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-xl overflow-y-auto">
        <form noValidate onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle className="font-headline">{deviceName} settings</DialogTitle>
            <DialogDescription>Changes reach the tablet right away, without a reload.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="device-name">Name</Label>
              <Input {...fieldErrorProps('device-name', fieldError('name'))} value={draft.name} maxLength={DEVICE_NAME_MAX} onChange={e => update({ name: e.target.value })} />
              <FieldError id="device-name">{fieldError('name')}</FieldError>
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-room">Room</Label>
              <Input {...fieldErrorProps('device-room', fieldError('room'))} value={draft.room} maxLength={DEVICE_ROOM_MAX} onChange={e => update({ room: e.target.value })} />
              <FieldError id="device-room">{fieldError('room')}</FieldError>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Sections on this tablet</legend>
            <p className="text-xs text-muted-foreground">Home and household notices are always on. A section that is off is hidden and its data is not readable on the tablet.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {DEVICE_SECTIONS.map(section => (
                <label key={section} className="flex min-h-12 items-center justify-between gap-3 rounded-md border px-3">
                  <span>{DEVICE_SECTION_LABELS[section]}</span>
                  <Switch
                    checked={draft.sections[section]}
                    aria-label={`Show ${DEVICE_SECTION_LABELS[section]}`}
                    onCheckedChange={(on) => {
                      const sections = { ...draft.sections, [section]: on };
                      const pageSection = startPageSection(draft.startPage);
                      // Switching off the start page's section moves the start page to Home (D-T18).
                      update({ sections, ...(pageSection === section && !on ? { startPage: { kind: 'home' } as DeviceStartPage } : {}) });
                    }}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="device-start">Start page</Label>
            <Select value={currentKey} onValueChange={key => update({ startPage: startPageFromKey(key) })}>
              <SelectTrigger id="device-start" className="min-h-12" aria-describedby={fieldError('startPage') ? 'device-start-error' : undefined}><SelectValue /></SelectTrigger>
              <SelectContent>
                {offerable.map(option => <SelectItem key={option.key} value={option.key}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <FieldError id="device-start">{fieldError('startPage')}</FieldError>
          </div>

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">Comfort (anyone at the tablet can change these too)</legend>
            <div className="space-y-2">
              <Label htmlFor="device-theme">Theme</Label>
              <Select value={draft.comfort.theme} onValueChange={value => update({ comfort: { ...draft.comfort, theme: value as DeviceSettings['comfort']['theme'] } })}>
                <SelectTrigger id="device-theme" className="min-h-12"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">Match the tablet</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-text">Text size</Label>
              <Select value={String(draft.comfort.textScale)} onValueChange={value => update({ comfort: { ...draft.comfort, textScale: Number(value) as 100 | 115 | 130 } })}>
                <SelectTrigger id="device-text" className="min-h-12"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="100">100%</SelectItem>
                  <SelectItem value="115">115%</SelectItem>
                  <SelectItem value="130">130%</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-motion">Motion</Label>
              <Select value={draft.comfort.motion} onValueChange={value => update({ comfort: { ...draft.comfort, motion: value as DeviceSettings['comfort']['motion'] } })}>
                <SelectTrigger id="device-motion" className="min-h-12"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">Match the tablet</SelectItem>
                  <SelectItem value="reduced">Reduced</SelectItem>
                  <SelectItem value="full">Full</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex min-h-12 items-center justify-between gap-3 self-end rounded-md border px-3">
              <span>Sounds</span>
              <Switch checked={draft.comfort.sound} aria-label="Play sounds" onCheckedChange={on => update({ comfort: { ...draft.comfort, sound: on } })} />
            </label>
          </fieldset>

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">Display</legend>
            <label className="flex min-h-12 items-center justify-between gap-3 rounded-md border px-3">
              <span>Live weather</span>
              <Switch checked={draft.display.weather} aria-label="Show live weather" onCheckedChange={on => update({ display: { ...draft.display, weather: on } })} />
            </label>
            <label className="flex min-h-12 items-center justify-between gap-3 rounded-md border px-3">
              <span>Seasonal touches</span>
              <Switch checked={draft.display.seasonal} aria-label="Show seasonal touches" onCheckedChange={on => update({ display: { ...draft.display, seasonal: on } })} />
            </label>
            <div className="space-y-2">
              <Label htmlFor="device-place">Weather place</Label>
              <Input
                {...fieldErrorProps('device-place', fieldError('display'))}
                value={draft.display.weatherPlace ?? ''}
                maxLength={WEATHER_PLACE_MAX}
                placeholder="e.g. Austin"
                onChange={e => update({ display: { ...draft.display, weatherPlace: e.target.value === '' ? null : e.target.value } })}
              />
              <FieldError id="device-place">{fieldError('display')}</FieldError>
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-unit">Temperature</Label>
              <Select value={draft.display.temperatureUnit} onValueChange={value => update({ display: { ...draft.display, temperatureUnit: value as 'C' | 'F' } })}>
                <SelectTrigger id="device-unit" className="min-h-12"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="C">°C</SelectItem>
                  <SelectItem value="F">°F</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </fieldset>

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">When nobody is using it</legend>
            <div className="space-y-2">
              <Label htmlFor="device-idle-home">Back to the start page after</Label>
              <Select value={String(draft.idle.homeAfterSec)} onValueChange={value => update({ idle: { ...draft.idle, homeAfterSec: Number(value) } })}>
                <SelectTrigger id="device-idle-home" className="min-h-12"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[...new Set([...IDLE_HOME_OPTIONS, draft.idle.homeAfterSec])].sort((a, b) => a - b).map(seconds => (
                    <SelectItem key={seconds} value={String(seconds)}>{durationLabel(seconds)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-idle-ambient">Ambient screen after</Label>
              <Select value={String(draft.idle.ambientAfterSec)} onValueChange={value => update({ idle: { ...draft.idle, ambientAfterSec: Number(value) } })}>
                <SelectTrigger id="device-idle-ambient" className="min-h-12" aria-describedby={fieldError('idle') ? 'device-idle-ambient-error' : undefined}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[...new Set([...IDLE_AMBIENT_OPTIONS, draft.idle.ambientAfterSec])].sort((a, b) => a - b).map(seconds => (
                    <SelectItem key={seconds} value={String(seconds)}>{durationLabel(seconds)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError id="device-idle-ambient">{fieldError('idle')}</FieldError>
            </div>
            <div className="space-y-2">
              <Label htmlFor="device-camera">Camera for scanning</Label>
              <Select value={draft.camera} onValueChange={value => update({ camera: value as 'front' | 'rear' })}>
                <SelectTrigger id="device-camera" className="min-h-12"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="front">Front</SelectItem>
                  <SelectItem value="rear">Rear</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </fieldset>

          {error?.field === 'form' && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" className="min-h-12" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" className="min-h-12" disabled={!dirty || saving}>
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
