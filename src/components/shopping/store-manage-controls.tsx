'use client';

import { useEffect, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToastAction } from '@/components/ui/toast';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { toast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { isBrowserOffline } from '@/lib/firestore-offline';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import type { TrackedWrite, WriteKind } from '@/lib/shopping/save-status';
import { rejectedInputRestore } from '@/lib/shopping/save-line';
import {
  checkStoreRename,
  deleteStoreQuestion,
  listsUsingStore,
  storeDeletedSubject,
  outcomeAppliesTo,
  storeRenamedSubject,
  storeRestoredSubject,
  undoRemaining,
  type StoreRestore,
} from '@/lib/shopping/store-manage';
import { deleteStoreAndUnassign, renameStore, restoreDeletedStore } from '@/lib/shopping/store-writes';
import { useLiveShoppingLists } from '@/lib/shopping/live';
import type { ShoppingStore } from '@/lib/types';

type Track = <T>(write: Promise<T>, options: {
  kind: WriteKind;
  subject: string;
  failTitle: string;
  onRejected?: () => void;
}) => Promise<TrackedWrite<T>>;

type PendingUndo = { restore: StoreRestore; at: number };

/**
 * Rename and delete for the list's store, inside Manage Categories (rendered
 * only while the dialog is open). Rename writes the name and the server's
 * `updatedAt` (queued offline). Delete, for members with `shopping.delete`,
 * asks first (the store by name and how many lists use it), then deletes the
 * store and clears `storeId` on those lists in one transaction (needs a
 * connection), and offers the shared 10-second Undo here; if the dialog closes
 * within the window, the Undo moves to a toast for the time left. The
 * household's lists come from the same live query the Shopping page holds
 * (Firestore shares one listen for identical queries), and `shopping.delete`
 * from the signed-in member's permissions. Every control uses the shared
 * Button and Input default height (`--target-min`: 44 px, 48 px on touch).
 */
export function StoreManageControls({
  householdId,
  store,
  stores,
  uid,
  online,
  ready,
  track,
}: {
  householdId: string;
  /** The list's store, when it is loaded; null for none or a deleted one. */
  store: ShoppingStore | null;
  stores: ShoppingStore[];
  uid: string | null;
  online: boolean;
  /** The list's store and the stores are known (the select is enabled) and no new store is being named. */
  ready: boolean;
  track: Track;
}) {
  const { permissions } = useAuth();
  const canDelete = Boolean(permissions['shopping.delete']);
  const lists = useLiveShoppingLists(householdId).value;
  const [mode, setMode] = useState<'idle' | 'rename' | 'confirm-delete'>('idle');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef(name);
  useEffect(() => {
    nameRef.current = name;
  }, [name]);
  const [pending, setPending] = useState<PendingUndo | null>(null);
  const pendingRef = useRef<PendingUndo | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  // Only what a late Undo needs to run; what it decides on is read from Firestore then.
  const latest = useRef({ householdId, uid, track });
  useEffect(() => {
    latest.current = { householdId, uid, track };
  }, [householdId, uid, track]);
  const mounted = useRef(true);

  // A store deleted elsewhere (or this one once deleted) ends any rename or confirm.
  const storeId = store?.id ?? null;
  const [shownStoreId, setShownStoreId] = useState(storeId);
  if (shownStoreId !== storeId) {
    setShownStoreId(storeId);
    setMode('idle');
    setName('');
    setError(null);
  }
  // The store selected now (read when a write submitted earlier answers late).
  const currentStoreId = useRef(storeId);
  useEffect(() => {
    currentStoreId.current = storeId;
  }, [storeId]);

  // The Undo leaves when its window ends.
  useEffect(() => {
    if (!pending) return;
    const handle = setTimeout(() => setPending(null), undoRemaining(pending.at, Date.now(), UNDO_WINDOW_MS));
    return () => clearTimeout(handle);
  }, [pending]);

  const undo = async (entry: PendingUndo, fromToast: boolean) => {
    const { householdId: household, uid: restorer, track: run } = latest.current;
    if (!restorer) return;
    if (mounted.current) setPending(null);
    if (isBrowserOffline()) {
      toast({ variant: 'destructive', title: `Could not restore ${entry.restore.name}`, description: 'Undo needs a connection.' });
      return;
    }
    const tracked = await run(restoreDeletedStore(household, entry.restore, { uid: restorer }), {
      kind: 'transaction',
      subject: `${entry.restore.name} restored`,
      failTitle: `Could not restore ${entry.restore.name}`,
    });
    const final = tracked.state === 'saved' ? { state: 'saved' as const, value: tracked.value } : await tracked.settled;
    if (final.state !== 'saved' || !final.value) return;
    // The rules make a store re-created by someone other than its creator theirs: say so.
    if (fromToast || !mounted.current || final.value.restoredAsYours) {
      toast({ title: storeRestoredSubject(entry.restore.name, final.value.restoredAsYours) });
    }
  };
  const undoRef = useRef(undo);
  useEffect(() => {
    undoRef.current = undo;
  });

  // Closing the dialog (this unmounts) within the window hands the Undo to a toast.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const entry = pendingRef.current;
      if (!entry) return;
      const left = undoRemaining(entry.at, Date.now(), UNDO_WINDOW_MS);
      if (left < 1000) return;
      const handle = toast({
        title: `${entry.restore.name} deleted`,
        duration: left,
        action: (
          <ToastAction altText={`Undo deleting ${entry.restore.name}`} onClick={() => { handle.dismiss(); void undoRef.current(entry, true); }}>
            Undo
          </ToastAction>
        ),
      });
    };
  }, []);

  const startRename = () => {
    if (!store) return;
    setName(store.name);
    setError(null);
    setMode('rename');
  };

  const saveRename = async () => {
    if (!store) return;
    const check = checkStoreRename(name, store.id, stores);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(null);
    setMode('idle');
    if (check.unchanged) return;
    const target = store;
    await track(renameStore(householdId, target.id, check.name), {
      kind: 'write',
      subject: storeRenamedSubject(target.name, check.name),
      failTitle: `Could not rename ${target.name}`,
      // The name comes back in the field only while the same store is selected and
      // nothing else was typed there since; never into another store's rename.
      onRejected: () => {
        if (!mounted.current || !outcomeAppliesTo(target.id, currentStoreId.current)) return;
        const restore = rejectedInputRestore(nameRef.current, check.name);
        if (!restore.restored) return;
        setName(restore.value);
        setMode('rename');
      },
    });
  };

  const usingIds = store ? listsUsingStore(store.id, lists) : [];

  const confirmDelete = async () => {
    if (!store || !online) return;
    const target = store;
    const listIds = listsUsingStore(target.id, lists);
    setMode('idle');
    const tracked = await track(deleteStoreAndUnassign(householdId, target.id, { listIds, name: target.name }), {
      kind: 'transaction',
      subject: storeDeletedSubject(target.name, listIds.length),
      failTitle: `Could not delete ${target.name}`,
    });
    const final = tracked.state === 'saved' ? { state: 'saved' as const, value: tracked.value } : await tracked.settled;
    if (final.state !== 'saved' || !final.value) return;
    const entry = { restore: final.value, at: Date.now() };
    if (mounted.current) setPending(entry);
    else {
      // Closed while the delete was still settling: the Undo goes straight to a toast.
      const handle = toast({
        title: storeDeletedSubject(target.name, final.value.listIds.length),
        duration: UNDO_WINDOW_MS,
        action: (
          <ToastAction altText={`Undo deleting ${target.name}`} onClick={() => { handle.dismiss(); void undoRef.current(entry, true); }}>
            Undo
          </ToastAction>
        ),
      });
    }
  };

  const question = store ? deleteStoreQuestion(store.name, usingIds.length) : null;

  return (
    <div className="space-y-2">
      {store && ready && mode === 'idle' && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={startRename}>
            <Pencil className="mr-2 h-4 w-4" aria-hidden /> Rename store
          </Button>
          {canDelete && (
            <Button
              type="button"
              variant="outline"
              className="hover:text-destructive"
              onClick={() => setMode('confirm-delete')}
            >
              <Trash2 className="mr-2 h-4 w-4" aria-hidden /> Delete store
            </Button>
          )}
        </div>
      )}

      {store && ready && mode === 'rename' && (
        <div className="space-y-1">
          <label htmlFor="rename-store-name" className="text-sm font-medium">Store name</label>
          <div className="flex flex-col gap-2 min-[400px]:flex-row">
            <Input
              value={name}
              autoFocus
              maxLength={80}
              enterKeyHint="done"
              onFocus={(event) => {
                // Once the on-screen keyboard is up, keep the field in view inside the dialog.
                const field = event.currentTarget;
                setTimeout(() => field.scrollIntoView({ block: 'nearest' }), 300);
              }}
              onChange={(event) => { setName(event.target.value); if (error) setError(null); }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveRename(); } }}
              {...fieldErrorProps('rename-store-name', error)}
            />
            <div className="flex gap-2">
              <Button type="button" className="flex-1" onClick={() => void saveRename()}>Save name</Button>
              <Button type="button" variant="ghost" className="flex-1" onClick={() => { setMode('idle'); setError(null); }}>Cancel</Button>
            </div>
          </div>
          <FieldError id="rename-store-name">{error}</FieldError>
          <p className="text-sm text-muted-foreground">Every list at this store shows the new name.</p>
        </div>
      )}

      {store && ready && question && mode === 'confirm-delete' && (
        <div role="group" aria-labelledby="delete-store-title" aria-describedby="delete-store-body" className="space-y-2 rounded-lg border border-destructive/50 p-3" data-testid="delete-store-confirm">
          <p id="delete-store-title" className="font-medium">{question.title}</p>
          <p id="delete-store-body" className="text-sm text-muted-foreground">{question.body}</p>
          {!online && <p className="text-sm text-muted-foreground">Deleting a store needs a connection.</p>}
          <div className="flex flex-col gap-2 min-[400px]:flex-row">
            <Button
              type="button"
              variant="destructive"
              // A long store name wraps instead of overflowing a phone; the box never drops under the target.
              className="h-auto min-h-[var(--target-min)] whitespace-normal break-words"
              aria-disabled={!online || undefined}
              autoFocus
              onClick={() => void confirmDelete()}
            >
              Delete {store.name}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode('idle')}>Cancel</Button>
          </div>
        </div>
      )}

      {pending && (
        <div role="status" className="flex items-center gap-2 rounded-lg border py-1 pl-3 pr-1" data-testid="store-undo">
          <p className="min-w-0 flex-1 break-words text-sm">
            {pending.restore.name} deleted.{!online && ' Undo needs a connection.'}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="shrink-0 px-4 font-semibold text-primary"
            aria-label={`Undo deleting ${pending.restore.name}`}
            aria-disabled={!online || undefined}
            onClick={() => { if (online) void undo(pending, false); }}
          >
            Undo
          </Button>
        </div>
      )}
    </div>
  );
}
