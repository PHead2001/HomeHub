'use client';

import { useMemo, useState } from 'react';
import { BellRing, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { entityName, type HomeAssistantEntitySummary } from '@/lib/automation/entities';
import { MAX_ALERT_RULES, mayWatch, type AlertRule, type AutomationConfig, type ConfigChange } from '@/lib/automation/config';

/** AU-9: a new token, tested by the server before it replaces the old one. */
export function ReplaceTokenDialog({ open, onOpenChange, onReplace }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReplace: (token: string) => Promise<string | null>;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (token.trim().length < 20) {
      setError('Paste the full long-lived access token.');
      return;
    }
    setBusy(true);
    setError(await onReplace(token.trim()));
    setBusy(false);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) { onOpenChange(next); setToken(''); setError(null); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update the token</DialogTitle>
          <DialogDescription>HomeHub tests the new token first. The old one stays until the new one works.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="space-y-1.5">
          <Label htmlFor="ha-new-token">New long-lived access token</Label>
          <Input id="ha-new-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Test and replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const newRuleId = () => Math.random().toString(36).slice(2, 12);

/**
 * Owners and admins (automation.manage): who sees people and cameras (AU-11), and alert
 * rules such as "garage open 10 min after 22:00" (AU-17). Saved on the server, which
 * validates everything again.
 */
export function AutomationSettings({ config, entities, saving, onChange }: {
  config: AutomationConfig;
  entities: HomeAssistantEntitySummary[];
  saving: boolean;
  /** One change; the server applies it to the stored settings. */
  onChange: (change: ConfigChange) => Promise<boolean>;
}) {
  const watchable = useMemo(() => entities.filter((entity) => mayWatch(entity.entity_id))
    .sort((a, b) => entityName(a).localeCompare(entityName(b))), [entities]);
  const names = useMemo(() => new Map(entities.map((entity) => [entity.entity_id, entityName(entity)])), [entities]);
  const [entityId, setEntityId] = useState('');
  const [minutes, setMinutes] = useState('10');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const addRule = async () => {
    const count = Number(minutes);
    if (!entityId) return setFormError('Choose a device.');
    if (!Number.isInteger(count) || count < 0 || count > 1440) return setFormError('Minutes must be a whole number from 0 to 1440.');
    if (Boolean(from) !== Boolean(to) || (from && from === to)) return setFormError('Give both times, and make them different, or neither.');
    setFormError(null);
    const rule: AlertRule = { id: newRuleId(), entityId, minutes: count, from: from || null, to: to || null };
    if (await onChange({ kind: 'alertAdd', rule })) {
      setEntityId('');
      setFrom('');
      setTo('');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-headline text-lg">Privacy and alerts</CardTitle>
        <CardDescription>Only owners and admins see this.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <Label htmlFor="ha-show-sensitive" className="space-y-1 font-normal">
            <span className="block font-medium">Let members see people, locations, cameras and locks</span>
            <span className="block text-sm text-muted-foreground">Off: only owners and admins see them. Children and guests never do.</span>
          </Label>
          <Switch
            id="ha-show-sensitive"
            className="mt-1"
            checked={config.showSensitiveToMembers}
            disabled={saving}
            onCheckedChange={(checked) => void onChange({ kind: 'showSensitiveToMembers', show: checked })}
          />
        </div>

        <section aria-labelledby="ha-alerts-heading" className="space-y-3">
          <h3 id="ha-alerts-heading" className="flex items-center gap-2 font-medium"><BellRing className="h-4 w-4" /> Alerts</h3>
          <p className="text-sm text-muted-foreground">
            Notify everyone who can see Automation when a door, window, light, switch or fan stays open or on. Leaks and smoke
            always notify; low batteries and filters become Maintenance notices. During quiet hours alerts arrive without a push, except leaks and smoke.
          </p>
          {config.alerts.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {config.alerts.map((rule) => (
                <li key={rule.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    {names.get(rule.entityId) ?? rule.entityId}: open or on for {rule.minutes} min
                    {rule.from && rule.to ? `, between ${rule.from} and ${rule.to}` : ', any time'}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={saving}
                    aria-label={`Remove the alert for ${names.get(rule.entityId) ?? rule.entityId}`}
                    onClick={() => void onChange({ kind: 'alertRemove', id: rule.id })}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {config.alerts.length < MAX_ALERT_RULES && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                Device
                <select className="h-[var(--target-min)] rounded-md border bg-background px-2" value={entityId} onChange={(event) => setEntityId(event.target.value)}>
                  <option value="">Choose a device</option>
                  {watchable.map((entity) => <option key={entity.entity_id} value={entity.entity_id}>{entityName(entity)}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Open or on for (minutes)
                <Input type="number" inputMode="numeric" min={0} max={1440} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-sm">From (optional)<Input type="time" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
                <label className="flex flex-col gap-1 text-sm">To<Input type="time" value={to} onChange={(event) => setTo(event.target.value)} /></label>
              </div>
              {formError && <p role="alert" className="text-sm text-destructive sm:col-span-2">{formError}</p>}
              <Button className="sm:col-span-2 sm:w-fit" variant="outline" disabled={saving} onClick={() => void addRule()}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Add alert
              </Button>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
