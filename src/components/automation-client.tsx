'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Plug, RefreshCw, Search, Unplug } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { auth } from '@/lib/firebase';
import {
  disconnectHomeAssistant,
  getHomeAssistantEntities,
  getHomeAssistantStatus,
  saveHomeAssistantConnection,
} from '@/app/automation/actions';
import type { HomeAssistantEntitySummary } from '@/lib/server/home-assistant';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';

const credentialsSchema = z.object({
  url: z.string().trim().url('Enter the full address, starting with https://'),
  accessToken: z.string().trim().min(20, 'Paste the full long-lived access token.'),
});
type Credentials = z.infer<typeof credentialsSchema>;

const domainLabel = (entityId: string) => {
  const domain = entityId.split('.')[0] || 'other';
  const labels: Record<string, string> = {
    light: 'Lights', switch: 'Switches', sensor: 'Sensors', binary_sensor: 'Sensors', climate: 'Climate',
    lock: 'Locks', cover: 'Covers & blinds', media_player: 'Media', fan: 'Fans', camera: 'Cameras',
    person: 'People', device_tracker: 'People', weather: 'Weather', alarm_control_panel: 'Security',
  };
  return labels[domain] || 'Other';
};

function CredentialsForm({ onSaved }: { onSaved: (host: string, count: number) => void }) {
  const { currentUser } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Credentials>({ resolver: zodResolver(credentialsSchema), defaultValues: { url: '', accessToken: '' } });

  const onSubmit = async (values: Credentials) => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || !currentUser?.householdId) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await saveHomeAssistantConnection(
        { idToken: await firebaseUser.getIdToken(), householdId: currentUser.householdId },
        values
      );
      // Entered values stay in the form when something goes wrong.
      if (!result.ok) setError(result.message);
      else onSaved(result.data.host, result.data.entityCount);
    } catch {
      setError('We could not reach HomeHub. Check your connection and try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="w-full max-w-lg">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <CardHeader>
            <CardTitle className="font-headline flex items-center gap-2"><Plug className="h-5 w-5" /> Connect Home Assistant</CardTitle>
            <CardDescription>
              See the state of your lights, sensors and devices in HomeHub. HomeHub only reads states; it never controls devices.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertTitle>Could not connect</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Home Assistant address</FormLabel>
                  <FormControl>
                    <Input placeholder="https://your-home.ui.nabu.casa" inputMode="url" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>Must be an https address that works away from home, such as Nabu Casa.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="accessToken"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Long-lived access token</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="Paste your token" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>In Home Assistant, open your profile, then Security, then Create token.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isSubmitting ? 'Checking connection…' : 'Test and connect'}
            </Button>
          </CardFooter>
        </form>
      </Form>
    </Card>
  );
}

export function AutomationClient() {
  const { currentUser, permissions } = useAuth();
  const { toast } = useToast();
  const canManage = Boolean(permissions['automation.manage']);
  const [status, setStatus] = useState<{ configured: boolean; host: string | null } | null>(null);
  const [entities, setEntities] = useState<HomeAssistantEntitySummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDisconnectOpen, setIsDisconnectOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const context = useCallback(async () => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || !currentUser?.householdId) return null;
    return { idToken: await firebaseUser.getIdToken(), householdId: currentUser.householdId };
  }, [currentUser?.householdId]);

  const loadEntities = useCallback(async () => {
    const ctx = await context();
    if (!ctx) return;
    setIsRefreshing(true);
    setLoadError(null);
    const result = await getHomeAssistantEntities(ctx).catch(() => ({ ok: false as const, message: 'We could not reach HomeHub. Check your connection.' }));
    if (result.ok) setEntities(result.data);
    else {
      setEntities([]);
      setLoadError(result.message);
    }
    setIsRefreshing(false);
  }, [context]);

  const loadStatus = useCallback(async () => {
    const ctx = await context();
    if (!ctx) return;
    const result = await getHomeAssistantStatus(ctx).catch(() => ({ ok: false as const, message: 'We could not reach HomeHub.' }));
    if (!result.ok) {
      setStatus({ configured: false, host: null });
      setLoadError(result.message);
      return;
    }
    setStatus(result.data);
    if (result.data.configured) await loadEntities();
  }, [context, loadEntities]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleDisconnect = async () => {
    setIsDisconnectOpen(false);
    const ctx = await context();
    if (!ctx) return;
    const result = await disconnectHomeAssistant(ctx);
    if (!result.ok) {
      toast({ variant: 'destructive', title: 'Could not disconnect', description: result.message });
      return;
    }
    setStatus({ configured: false, host: null });
    setEntities(null);
    setLoadError(null);
    toast({ title: 'Disconnected', description: 'Home Assistant is no longer connected to this household.' });
  };

  const grouped = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const visible = (entities || []).filter(entity => !term
      || entity.entity_id.toLowerCase().includes(term)
      || (entity.attributes.friendly_name || '').toLowerCase().includes(term));
    const groups = new Map<string, HomeAssistantEntitySummary[]>();
    for (const entity of visible) {
      const label = domainLabel(entity.entity_id);
      groups.set(label, [...(groups.get(label) || []), entity]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entities, filter]);

  if (!status) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading Home Assistant">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!status.configured) {
    if (!canManage) {
      return (
        <Alert className="max-w-lg">
          <AlertTitle>Home Assistant is not connected</AlertTitle>
          <AlertDescription>Ask a household owner or admin to connect it. You will see device states here afterwards.</AlertDescription>
        </Alert>
      );
    }
    return (
      <div className="flex justify-center py-6">
        <CredentialsForm
          onSaved={(host, count) => {
            toast({ title: 'Connected', description: `Found ${count} ${count === 1 ? 'device' : 'devices'} at ${host}.` });
            void loadStatus();
          }}
        />
      </div>
    );
  }

  return (
    <>
      <AlertDialog open={isDisconnectOpen} onOpenChange={setIsDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Home Assistant?</AlertDialogTitle>
            <AlertDialogDescription>
              HomeHub will forget the address and token. You can connect again any time with a new token.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} className={buttonVariants({ variant: 'destructive' })}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="font-headline">Devices</CardTitle>
            <CardDescription>
              Live states from {status.host || 'Home Assistant'}{entities ? ` · ${entities.length} entities` : ''}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void loadEntities()} disabled={isRefreshing}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} /> Refresh
            </Button>
            {canManage && (
              <Button variant="outline" onClick={() => setIsDisconnectOpen(true)}>
                <Unplug className="mr-2 h-4 w-4" /> Disconnect
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadError && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Could not load devices</AlertTitle>
              <AlertDescription>
                {loadError}
                {canManage && ' If the address or token changed, disconnect and connect again.'}
              </AlertDescription>
            </Alert>
          )}
          {entities && entities.length > 0 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={event => setFilter(event.target.value)}
                placeholder="Search devices"
                aria-label="Search devices"
                className="pl-9"
              />
            </div>
          )}
          {entities === null || (isRefreshing && entities.length === 0) ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map(key => <Skeleton key={key} className="h-12 w-full" />)}
            </div>
          ) : grouped.length === 0 && !loadError ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {filter ? 'No devices match your search.' : 'Home Assistant did not report any devices.'}
            </p>
          ) : (
            grouped.map(([label, items]) => (
              <section key={label} aria-label={label}>
                <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{label} <span className="font-normal">({items.length})</span></h3>
                <ul className="divide-y rounded-lg border">
                  {items.map(entity => (
                    <li key={entity.entity_id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{entity.attributes.friendly_name || entity.entity_id}</p>
                        <p className="truncate font-code text-xs text-muted-foreground">{entity.entity_id}</p>
                      </div>
                      <span className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
                        {entity.state}{entity.attributes.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </CardContent>
      </Card>
    </>
  );
}
