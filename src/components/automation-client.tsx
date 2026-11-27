'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, KeyRound, RefreshCw, Search, Unplug } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { auth } from '@/lib/firebase';
import {
  disconnectHomeAssistant,
  getHomeAssistantEntities,
  getHomeAssistantStatus,
  replaceHomeAssistantToken,
  setAutomationFavorite,
  setMembersSeeSensitive,
  type HomeAssistantEntities,
  type HomeAssistantStatus,
} from '@/app/automation/actions';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { EmptyState } from '@/components/empty-state';
import { friendlyError } from '@/lib/friendly-error';
import { cn } from '@/lib/utils';
import { householdDayZone } from '@/lib/household-zone';
import { arrangeEntities } from '@/lib/automation/entities';
import { EMPTY_AUTOMATION_CONFIG, type ConfigChange } from '@/lib/automation/config';
import { POLL_INTERVAL_MS, pollDue, updatedLabel } from '@/lib/automation/refresh';
import { ConnectForm } from '@/components/automation/connect-form';
import { EntityTile } from '@/components/automation/entity-tile';
import { AutomationSettings, ReplaceTokenDialog } from '@/components/automation/automation-settings';

type Failure = { ok: false; message: string };

/** Each kind of settings change has its own server action. */
const sendConfigChange = (ctx: { idToken: string; householdId: string }, change: ConfigChange) => {
  switch (change.kind) {
    case 'favorite':
      return setAutomationFavorite(ctx, { entityId: change.entityId, pinned: change.pinned });
    case 'showSensitiveToMembers':
      return setMembersSeeSensitive(ctx, { show: change.show });
  }
};
const failure = (error: unknown): Failure => ({ ok: false, message: friendlyError(error) });

/** Visible page: polls only while the tab is shown (AU-1). */
const useVisible = () => {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
};

export function AutomationClient() {
  const { currentUser, permissions, household } = useAuth();
  const { toast } = useToast();
  const canManage = Boolean(permissions['automation.manage']);
  const timeZone = householdDayZone(household?.timeZone);
  const visible = useVisible();
  const [status, setStatus] = useState<HomeAssistantStatus | null>(null);
  const [list, setList] = useState<HomeAssistantEntities | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDisconnectOpen, setIsDisconnectOpen] = useState(false);
  const [isReplaceOpen, setIsReplaceOpen] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const lastAttempt = useRef<number | null>(null);

  const context = useCallback(async () => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser || !currentUser?.householdId) return null;
    return { idToken: await firebaseUser.getIdToken(), householdId: currentUser.householdId };
  }, [currentUser?.householdId]);

  const loadEntities = useCallback(async () => {
    if (inFlight.current) return;
    const ctx = await context();
    if (!ctx) return;
    inFlight.current = true;
    lastAttempt.current = Date.now();
    setIsRefreshing(true);
    const result = await getHomeAssistantEntities(ctx).catch(failure);
    if (result.ok) {
      setList(result.data);
      setLoadError(null);
    } else {
      // A failed refresh keeps the last list, marked by its "Updated … ago".
      setList((current) => current ?? { entities: [], fetchedAt: Date.now(), total: 0, truncated: false, hiddenSensitive: 0 });
      setLoadError(result.message);
    }
    inFlight.current = false;
    setIsRefreshing(false);
  }, [context]);

  const loadStatus = useCallback(async () => {
    const ctx = await context();
    if (!ctx) return;
    const result = await getHomeAssistantStatus(ctx).catch(failure);
    if (!result.ok) {
      setStatus({ configured: false, host: null, config: { ...EMPTY_AUTOMATION_CONFIG }, canSeeSensitive: false });
      setLoadError(result.message);
      return;
    }
    setStatus(result.data);
    if (result.data.configured) await loadEntities();
  }, [context, loadEntities]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // AU-1: every 30 s while the page is visible, and at once when it becomes visible again.
  const configured = Boolean(status?.configured);
  useEffect(() => {
    if (!configured) return;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (pollDue({ visible: document.visibilityState === 'visible', inFlight: inFlight.current, lastAttempt: lastAttempt.current, now: at, interval: POLL_INTERVAL_MS })) void loadEntities();
    };
    tick();
    const id = window.setInterval(tick, 5_000);
    return () => window.clearInterval(id);
  }, [configured, visible, loadEntities]);

  // One change at a time: the server applies it to the stored settings, so this page
  // never sends back (and overwrites) settings someone else changed since it loaded.
  const changeSettings = useCallback(async (change: ConfigChange) => {
    const ctx = await context();
    if (!ctx) return false;
    setSavingConfig(true);
    const result = await sendConfigChange(ctx, change).catch(failure);
    setSavingConfig(false);
    if (!result.ok) {
      toast({ variant: 'destructive', title: 'Could not save', description: result.message });
      return false;
    }
    setStatus((current) => (current ? { ...current, config: result.data } : current));
    return true;
  }, [context, toast]);

  const handleReplace = async (token: string) => {
    const ctx = await context();
    if (!ctx) return 'Your sign-in has expired. Please sign in again.';
    const result = await replaceHomeAssistantToken(ctx, { accessToken: token }).catch(failure);
    if (!result.ok) return result.message;
    setIsReplaceOpen(false);
    toast({ title: 'Token updated', description: `HomeHub now uses the new token for ${result.data.host}.` });
    void loadStatus();
    return null;
  };

  const handleDisconnect = async () => {
    setIsDisconnectOpen(false);
    const ctx = await context();
    if (!ctx) return;
    const result = await disconnectHomeAssistant(ctx).catch(failure);
    if (!result.ok) {
      toast({ variant: 'destructive', title: 'Could not disconnect', description: result.message });
      return;
    }
    setStatus((current) => (current ? { ...current, configured: false, host: null } : current));
    setList(null);
    setLoadError(null);
    toast({ title: 'Disconnected', description: 'Home Assistant is no longer connected to this household.' });
  };

  const config = status?.config;
  const arranged = useMemo(
    () => arrangeEntities(list?.entities ?? [], { showAll, search: filter, favorites: config?.favorites }),
    [list, showAll, filter, config?.favorites],
  );

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
        <Card>
          <EmptyState
            kind="generic"
            title="Home Assistant isn't connected yet"
            description={loadError ?? 'Ask a household owner or admin to connect it. Your lights, sensors and devices will show up here.'}
          />
        </Card>
      );
    }
    return (
      <div className="flex justify-center py-6">
        <ConnectForm
          onSaved={(host, count) => {
            toast({ title: 'Connected', description: `Found ${count} ${count === 1 ? 'device' : 'devices'} at ${host}.` });
            void loadStatus();
          }}
        />
      </div>
    );
  }

  const entities = list?.entities ?? [];
  const updated = updatedLabel(list?.fetchedAt ?? null, now);
  const tile = (entity: (typeof entities)[number]) => (
    <EntityTile
      key={entity.entity_id}
      entity={entity}
      timeZone={timeZone}
      now={new Date(now)}
      favorite={Boolean(config?.favorites.includes(entity.entity_id))}
      canManage={canManage}
      onToggleFavorite={() => {
        if (!config) return;
        void changeSettings({ kind: 'favorite', entityId: entity.entity_id, pinned: !config.favorites.includes(entity.entity_id) });
      }}
    />
  );
  const grid = 'grid gap-3 md:grid-cols-2 xl:grid-cols-3';

  return (
    <div className="space-y-6">
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
      {canManage && <ReplaceTokenDialog open={isReplaceOpen} onOpenChange={setIsReplaceOpen} onReplace={handleReplace} />}

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="font-headline">Devices</CardTitle>
            <CardDescription>
              From {status.host || 'Home Assistant'}
              {updated ? <> · <span aria-live="polite">{updated}</span></> : null}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { lastAttempt.current = null; void loadEntities(); }} disabled={isRefreshing} aria-label={isRefreshing ? 'Refreshing devices' : 'Refresh devices'}>
              <RefreshCw className={cn('mr-2 h-4 w-4', isRefreshing && 'animate-spin')} /> Refresh
            </Button>
            {canManage && (
              <Button variant="outline" onClick={() => setIsReplaceOpen(true)}>
                <KeyRound className="mr-2 h-4 w-4" /> Update token
              </Button>
            )}
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
                {canManage && ' If the token changed, choose Update token.'}
              </AlertDescription>
            </Alert>
          )}
          {list?.truncated && (
            <p className="text-sm text-muted-foreground">Home Assistant reported {list.total} entities; HomeHub shows the first {entities.length}.</p>
          )}
          {entities.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={event => setFilter(event.target.value)}
                  placeholder="Search devices"
                  aria-label="Search devices"
                  className="pl-9"
                />
              </div>
              <Button variant="outline" aria-pressed={showAll} onClick={() => setShowAll((value) => !value)}>
                {showAll ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                {showAll ? 'Hide system items' : `Show all${arranged.hiddenCount ? ` (${arranged.hiddenCount} hidden)` : ''}`}
              </Button>
            </div>
          )}
          {list === null || (isRefreshing && entities.length === 0) ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map(key => <Skeleton key={key} className="h-12 w-full" />)}
            </div>
          ) : arranged.favorites.length === 0 && arranged.groups.length === 0 && !loadError ? (
            filter ? (
              <EmptyState
                compact
                headingLevel={3}
                title="No matches"
                description={`Nothing is called "${filter.trim()}". Try part of a name or a device ID.`}
                action={{ label: 'Clear search', onClick: () => setFilter('') }}
              />
            ) : (
              <EmptyState
                compact
                headingLevel={3}
                title="No devices yet"
                description={arranged.hiddenCount ? 'Only system items were found. Choose Show all to see them.' : "Home Assistant didn't report any devices. Add some there, then refresh."}
              />
            )
          ) : (
            <>
              {arranged.favorites.length > 0 && (
                <section aria-label="Favourites">
                  <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Favourites <span className="font-normal">({arranged.favorites.length})</span></h3>
                  <ul className={grid}>{arranged.favorites.map(tile)}</ul>
                </section>
              )}
              {arranged.groups.map(([label, items]) => (
                <section key={label} aria-label={label}>
                  <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{label} <span className="font-normal">({items.length})</span></h3>
                  <ul className={grid}>{items.map(tile)}</ul>
                </section>
              ))}
            </>
          )}
          {list && list.hiddenSensitive > 0 && (
            <p className="text-sm text-muted-foreground">People, locations, cameras and locks are shown to owners and admins only.</p>
          )}
        </CardContent>
      </Card>

      {canManage && config && (
        <AutomationSettings config={config} saving={savingConfig} onChange={changeSettings} />
      )}
    </div>
  );
}
