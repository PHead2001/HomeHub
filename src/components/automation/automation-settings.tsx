'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { AutomationConfig } from '@/lib/automation/config';

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

/**
 * Owners and admins (automation.manage): who sees people and cameras (AU-11). Saved on
 * the server, which validates it again.
 */
export function AutomationSettings({ config, saving, onSave }: {
  config: AutomationConfig;
  saving: boolean;
  onSave: (next: AutomationConfig) => Promise<boolean>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-headline text-lg">Privacy</CardTitle>
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
            onCheckedChange={(checked) => void onSave({ ...config, showSensitiveToMembers: checked })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
