'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChevronDown, Loader2, MonitorSmartphone, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { auth } from '@/lib/firebase-app';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/empty-state';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { ConfirmActionDialog, type ConfirmRequest } from '@/components/household/confirm-action-dialog';
import { DeviceCodeDialog, type ShownDeviceCode } from '@/components/household/device-code-dialog';
import { DeviceSettingsDialog } from '@/components/household/device-settings-form';
import { relativeTime } from '@/components/household/household-model';
import {
  createDeviceCodeAction,
  createDeviceRepairCodeAction,
  reconcileDeviceSessionsAction,
  removeDeviceAction,
  revokeDeviceCodeAction,
  updateDeviceSettingsAction,
  type DeviceActionResult,
} from '@/app/household/device-actions';
import { DEVICE_NAME_MAX, DEVICE_ROOM_MAX, DEVICE_SECTION_LABELS, defaultSections, readDeviceSettings, readLabel } from '@/lib/devices/settings';
import { DEVICE_SECTIONS, type DeviceSections, type DeviceSettings, type DeviceStatus } from '@/lib/devices/types';

// The Household "Devices" tab (WT-4): every wall tablet of the household with its
// name, room, truthful last seen (server time of its last heartbeat, judged against
// server time) and app version; add a tablet (device code + QR), edit settings, re-pair,
// remove, and the unused codes. Owners and admins only: the rules let nobody else read
// device records or codes, and every change is a server action that checks the role.

const ONLINE_WINDOW_MS = 15 * 60 * 1000;

type DeviceRow = {
  id: string;
  status: DeviceStatus;
  generation: number;
  settings: DeviceSettings;
  lastSeenAt: string | null;
  appVersion: string | null;
  removedAt: string | null;
};

type CodeRow = { code: string; kind: 'pair' | 'repair'; name: string; expiresAt: string; live: boolean };

const toIso = (value: unknown): string | null => {
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof value === 'string' ? value : null;
};

const statusOf = (value: unknown): DeviceStatus => (value === 'active' || value === 'unpaired' || value === 'removed' ? value : 'removed');

/** "Online", "Last seen 3 hours ago" or "Not seen yet", measured on the server's clock. */
export const deviceSeenLabel = (lastSeenAt: string | null, serverNowMs: number | null): { online: boolean; label: string } => {
  if (!lastSeenAt) return { online: false, label: 'Not seen yet' };
  const seen = new Date(lastSeenAt).getTime();
  if (serverNowMs !== null && serverNowMs - seen <= ONLINE_WINDOW_MS) return { online: true, label: 'Online' };
  return { online: false, label: `Last seen ${relativeTime(lastSeenAt, serverNowMs !== null ? new Date(serverNowMs) : new Date())}` };
};

/** Mounted only while open, so every opening starts empty. */
function NewDeviceDialog({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (input: { name: string; room: string; sections: DeviceSections }) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [sections, setSections] = useState<DeviceSections>(defaultSections());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameError = submitted && !readLabel(name, DEVICE_NAME_MAX) ? `Give the tablet a name of 1 to ${DEVICE_NAME_MAX} characters.` : null;
  const roomError = submitted && !readLabel(room, DEVICE_ROOM_MAX) ? `Give the room a name of 1 to ${DEVICE_ROOM_MAX} characters.` : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (busy || !readLabel(name, DEVICE_NAME_MAX) || !readLabel(room, DEVICE_ROOM_MAX)) return;
    setBusy(true);
    try {
      if (await onCreate({ name, room, sections })) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-md overflow-y-auto">
        <form noValidate onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle className="font-headline">Add a wall tablet</DialogTitle>
            <DialogDescription>You&apos;ll get a code and a QR code for the tablet. Everything here can be changed later.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-device-name">Tablet name</Label>
            <Input {...fieldErrorProps('new-device-name', nameError)} value={name} maxLength={DEVICE_NAME_MAX} placeholder="e.g. Kitchen tablet" onChange={e => setName(e.target.value)} />
            <FieldError id="new-device-name">{nameError}</FieldError>
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-device-room">Room</Label>
            <Input {...fieldErrorProps('new-device-room', roomError)} value={room} maxLength={DEVICE_ROOM_MAX} placeholder="e.g. Kitchen" onChange={e => setRoom(e.target.value)} />
            <FieldError id="new-device-room">{roomError}</FieldError>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Sections</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {DEVICE_SECTIONS.map(section => (
                <label key={section} className="flex min-h-12 items-center justify-between gap-3 rounded-md border px-3">
                  <span>{DEVICE_SECTION_LABELS[section]}</span>
                  <Switch checked={sections[section]} aria-label={`Show ${DEVICE_SECTION_LABELS[section]}`} onCheckedChange={on => setSections({ ...sections, [section]: on })} />
                </label>
              ))}
            </div>
          </fieldset>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" className="min-h-12" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" className="min-h-12" disabled={busy}>
              {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Create code
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DevicesTab({ householdId }: { householdId: string }) {
  const { toast } = useToast();
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [serverOffsetMs, setServerOffsetMs] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [adding, setAdding] = useState(false);
  const [shownCode, setShownCode] = useState<ShownDeviceCode | null>(null);
  const [editing, setEditing] = useState<DeviceRow | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const run = useCallback(async <T,>(failTitle: string, call: (idToken: string) => Promise<DeviceActionResult<T>>): Promise<T | null> => {
    const user = auth.currentUser;
    if (!user) {
      toast({ variant: 'destructive', title: failTitle, description: 'Your session has ended. Please sign in again.' });
      return null;
    }
    try {
      const result = await call(await user.getIdToken());
      if (result.ok) return result.data;
      toast({ variant: 'destructive', title: failTitle, description: result.message });
    } catch {
      toast({ variant: 'destructive', title: failTitle, description: 'We could not reach HomeHub. Check your connection and try again.' });
    }
    return null;
  }, [toast]);

  // Live device records and this household's codes.
  useEffect(() => {
    let stops: Array<() => void> = [];
    let stopped = false;
    void Promise.all([import('@/lib/firebase'), import('firebase/firestore')]).then(([{ db }, { collection, onSnapshot, query, where }]) => {
      if (stopped) return;
      stops = [
        onSnapshot(collection(db, 'households', householdId, 'devices'), snapshot => {
          setFailed(false);
          setDevices(snapshot.docs.map(d => {
            const data = d.data();
            return {
              id: d.id,
              status: statusOf(data.status),
              generation: typeof data.generation === 'number' ? data.generation : 0,
              settings: readDeviceSettings(data),
              lastSeenAt: toIso(data.lastSeenAt),
              appVersion: typeof data.appVersion === 'string' ? data.appVersion : null,
              removedAt: toIso(data.removedAt),
            };
          }).sort((a, b) => a.settings.name.localeCompare(b.settings.name)));
        }, () => setFailed(true)),
        onSnapshot(query(collection(db, 'deviceCodes'), where('householdId', '==', householdId)), snapshot => {
          const now = Date.now();
          setCodes(snapshot.docs.map(d => {
            const data = d.data();
            const expiresAt = toIso(data.expiresAt) ?? '';
            return {
              code: d.id,
              kind: data.kind === 'repair' ? 'repair' as const : 'pair' as const,
              name: typeof data.name === 'string' ? data.name : 'Tablet',
              expiresAt,
              live: !data.usedAt && !data.revokedAt && Boolean(expiresAt) && new Date(expiresAt).getTime() > now,
            };
          }).filter(code => code.live));
        }, () => setCodes([])),
      ];
    });
    return () => {
      stopped = true;
      stops.forEach(stop => stop());
    };
  }, [householdId]);

  // Opening the list finishes any pending tablet sign-out and learns the server's time.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const user = auth.currentUser;
      if (!user) return;
      try {
        const result = await reconcileDeviceSessionsAction({ idToken: await user.getIdToken(), householdId });
        if (!cancelled && result.ok) setServerOffsetMs(new Date(result.data.serverNow).getTime() - Date.now());
      } catch {
        // Online state then reads "Last seen"; nothing else depends on it.
      }
    })();
    const timer = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [householdId]);

  const serverNowMs = serverOffsetMs === null ? null : nowTick + serverOffsetMs;
  const current = useMemo(() => (devices ?? []).filter(d => d.status !== 'removed'), [devices]);
  const removed = useMemo(() => (devices ?? []).filter(d => d.status === 'removed'), [devices]);

  const createCode = async (input: { name: string; room: string; sections: DeviceSections }) => {
    const created = await run('Could not create a tablet code', idToken => createDeviceCodeAction({ idToken, householdId, ...input }));
    if (!created) return false;
    setShownCode({ ...created, name: input.name.trim() });
    return true;
  };

  const repair = async (device: DeviceRow) => {
    const created = await run('Could not create a re-pair code', idToken => createDeviceRepairCodeAction({ idToken, householdId, deviceId: device.id }));
    if (created) setShownCode({ ...created, name: device.settings.name });
  };

  const remove = (device: DeviceRow) => setConfirm({
    title: `Remove ${device.settings.name}?`,
    description: 'It is signed out at once and cannot be used again; nobody\'s account is affected. Owners and admins are notified. To use it again, pair it as a new tablet.',
    confirmLabel: 'Remove tablet',
    destructive: true,
    onConfirm: async () => {
      const result = await run('Could not remove the tablet', idToken => removeDeviceAction({ idToken, householdId, deviceId: device.id }));
      if (!result) return;
      toast({
        title: 'Tablet removed',
        description: result.authCleanup === 'done'
          ? `${device.settings.name} is signed out.`
          : `${device.settings.name} can no longer read or change anything. Its sign-out finishes shortly.`,
      });
    },
  });

  const revokeCode = async (code: CodeRow) => {
    if (await run('Could not cancel the code', idToken => revokeDeviceCodeAction({ idToken, householdId, code: code.code }))) {
      toast({ title: 'Code cancelled', description: `${code.code} can no longer be used.` });
    }
  };

  const saveSettings = async (device: DeviceRow, patch: Record<string, unknown>): Promise<string | null> => {
    const user = auth.currentUser;
    if (!user) return 'Your session has ended. Please sign in again.';
    try {
      const result = await updateDeviceSettingsAction({ idToken: await user.getIdToken(), householdId, deviceId: device.id, patch });
      if (result.ok) {
        toast({ title: 'Tablet updated', description: `${result.data.settings.name} picks up the change right away.` });
        return null;
      }
      return result.message;
    } catch {
      return 'We could not reach HomeHub. Check your connection and try again.';
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Wall tablets</CardTitle>
            <CardDescription>Tablets on a wall that anyone in the household can use. They have no account of their own; they act as whoever is standing at them.</CardDescription>
          </div>
          <Button className="min-h-12 shrink-0" onClick={() => setAdding(true)}>
            <Plus aria-hidden className="mr-2 h-4 w-4" /> Add a wall tablet
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {failed && <p role="status" className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">Tablets couldn&apos;t be loaded. Check your connection.</p>}
          {devices === null && !failed ? (
            <p role="status" className="text-sm text-muted-foreground"><Loader2 aria-hidden className="mr-2 inline h-4 w-4 animate-spin" />Loading tablets…</p>
          ) : current.length === 0 ? (
            <EmptyState
              compact
              headingLevel={3}
              title="No wall tablets yet"
              description="Add one to show chores, pets and the shopping list on a screen everyone can use."
            />
          ) : (
            <ul className="grid gap-3">
              {current.map(device => {
                const seen = deviceSeenLabel(device.lastSeenAt, serverNowMs);
                return (
                  <li key={device.id} className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <MonitorSmartphone aria-hidden className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{device.settings.name}</span>
                        <span className="text-sm text-muted-foreground">{device.settings.room}</span>
                        {device.status === 'unpaired'
                          ? <Badge variant="secondary">Needs re-pairing</Badge>
                          : <Badge variant={seen.online ? 'default' : 'secondary'}>{seen.label}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {DEVICE_SECTIONS.filter(section => device.settings.sections[section]).map(section => DEVICE_SECTION_LABELS[section]).join(', ') || 'Home only'}
                        {device.appVersion ? ` · Version ${device.appVersion}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {device.status === 'active' && (
                        <Button variant="outline" className="min-h-12" onClick={() => setEditing(device)} aria-label={`Settings for ${device.settings.name}`}>
                          <Settings2 aria-hidden className="mr-2 h-4 w-4" /> Settings
                        </Button>
                      )}
                      <Button variant="outline" className="min-h-12" onClick={() => void repair(device)} aria-label={`Re-pair ${device.settings.name}`}>
                        <RefreshCw aria-hidden className="mr-2 h-4 w-4" /> Re-pair
                      </Button>
                      <Button variant="outline" className="min-h-12" onClick={() => remove(device)} aria-label={`Remove ${device.settings.name}`}>
                        <Trash2 aria-hidden className="mr-2 h-4 w-4" /> Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {removed.length > 0 && (
            <div>
              <Button variant="ghost" className="min-h-12" aria-expanded={showRemoved} onClick={() => setShowRemoved(!showRemoved)}>
                <ChevronDown aria-hidden className={`mr-2 h-4 w-4 ${showRemoved ? 'rotate-180' : ''}`} /> Removed tablets ({removed.length})
              </Button>
              {showRemoved && (
                <ul className="mt-2 grid gap-2">
                  {removed.map(device => (
                    <li key={device.id} className="rounded-md border border-border-subtle p-3 text-sm text-muted-foreground">
                      {device.settings.name} · {device.settings.room}{device.removedAt ? ` · removed ${relativeTime(device.removedAt)}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {codes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Unused tablet codes</CardTitle>
            <CardDescription>Each code works once and lasts 15 minutes.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {codes.map(code => (
                <li key={code.code} className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <span className="font-code font-semibold tracking-wider">{code.code}</span>
                    <p className="text-sm text-muted-foreground">{code.kind === 'repair' ? 'Re-pair' : 'New tablet'}: {code.name} · expires {relativeTime(code.expiresAt)}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" className="min-h-12" onClick={() => setShownCode({ code: code.code, kind: code.kind, expiresAt: code.expiresAt, name: code.name })}>Show</Button>
                    <Button variant="outline" className="min-h-12" onClick={() => void revokeCode(code)} aria-label={`Cancel code ${code.code}`}>Cancel code</Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {adding && <NewDeviceDialog onClose={() => setAdding(false)} onCreate={createCode} />}
      <DeviceCodeDialog shown={shownCode} onClose={() => setShownCode(null)} />
      {editing && (
        <DeviceSettingsDialog
          key={editing.id}
          householdId={householdId}
          deviceName={editing.settings.name}
          settings={editing.settings}
          onClose={() => setEditing(null)}
          onSave={patch => saveSettings(editing, patch)}
        />
      )}
      <ConfirmActionDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
