'use client';

import { useRef, useState } from 'react';
import { Edit, ListPlus, Loader2, Package, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ToastAction } from '@/components/ui/toast';
import { useToast } from '@/hooks/use-toast';
import { USED_UP_UNDO_MS, packageChangeToast } from '@/lib/shopping/pantry-batches';
import { pluralize } from '@/lib/shopping/items';
import { onListCopy, putOnList, restockOne, undoPackageChanges, type ListTarget } from '@/lib/barcode/product-stock';
import type { BarcodeLibraryItem, ShoppingList } from '@/lib/types';

const ACTION = 'h-12 w-full justify-start text-base';

/**
 * A saved product's actions (BL-13): Add to list, Add to pantry, Edit and Delete,
 * each a full-width 48 px button in a bottom sheet. Add to list and Add to pantry
 * need `shopping.edit` (as on the Shopping page), Delete `shopping.delete`.
 */
export function ProductSheet({
  item,
  onOpenChange,
  householdId,
  uid,
  timeZone,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
}: {
  item: BarcodeLibraryItem | null;
  onOpenChange: (open: boolean) => void;
  householdId: string | null;
  uid: string | null;
  timeZone: string | null;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (item: BarcodeLibraryItem) => void;
  onDelete: (item: BarcodeLibraryItem) => void;
}) {
  const { toast, toastError } = useToast();
  const [busy, setBusy] = useState<'list' | 'pantry' | null>(null);
  const [lists, setLists] = useState<ShoppingList[] | null>(null);
  // The Undo toast closes itself when pressed.
  const undoDismiss = useRef<(() => void) | null>(null);

  const close = () => {
    setLists(null);
    onOpenChange(false);
  };

  const context = householdId && uid ? { householdId, uid, timeZone, onLateError: (error: unknown) => toastError(error, `Could not sync ${item?.name ?? 'the product'}`) } : null;

  const addToList = async (list?: ListTarget) => {
    if (!item || !context) return;
    setBusy('list');
    try {
      const answer = await putOnList(item.name, { ...context, list });
      if (answer.kind === 'pick') {
        setLists(answer.lists);
        return;
      }
      toast(onListCopy(item.name, answer.result));
      close();
    } catch (error) {
      toastError(error, 'Could not add to the shopping list');
    } finally {
      setBusy(null);
    }
  };

  const addToPantry = async () => {
    if (!item || !context) return;
    setBusy('pantry');
    try {
      const result = await restockOne({ barcode: item.id, name: item.name }, context);
      const shown = packageChangeToast(result.outcome, `Added ${result.name}`, result.merged ? 'One more package in the pantry.' : `${pluralize(1, 'item')} on the Pantry shelf.`);
      const handle = toast({
        title: shown.title,
        description: shown.description,
        ...(shown.offerUndo && result.undoable && result.changes.length > 0
          ? {
              duration: USED_UP_UNDO_MS,
              action: (
                <ToastAction altText={`Undo adding ${result.name}`} onClick={() => { undoDismiss.current?.(); void undoPackageChanges(result.changes, context).catch((error: unknown) => toastError(error, `Could not undo ${result.name}`)); }}>
                  Undo
                </ToastAction>
              ),
            }
          : {}),
      });
      undoDismiss.current = handle.dismiss;
      close();
    } catch (error) {
      toastError(error, 'Could not add to the pantry');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={Boolean(item)} onOpenChange={(open) => { if (!open) close(); }}>
      <SheetContent side="bottom" className="mx-auto max-w-lg rounded-t-2xl">
        <SheetHeader>
          <SheetTitle>{item?.name ?? 'Product'}</SheetTitle>
          <SheetDescription className="font-mono">{item?.id}</SheetDescription>
        </SheetHeader>
        {item && (
          <div className="mt-4 grid gap-2" data-testid="product-actions">
            {lists ? (
              <>
                <p className="text-sm font-medium">Which list?</p>
                {lists.map((list) => (
                  <Button key={list.id} variant="outline" className={ACTION} disabled={busy !== null} onClick={() => void addToList(list)}>
                    <ListPlus className="mr-2 h-5 w-5" aria-hidden /> {list.name}
                  </Button>
                ))}
              </>
            ) : (
              <>
                {canEdit && (
                  <Button variant="outline" className={ACTION} disabled={busy !== null} onClick={() => void addToList()}>
                    {busy === 'list' ? <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> : <ListPlus className="mr-2 h-5 w-5" aria-hidden />}
                    Add to list
                  </Button>
                )}
                {canEdit && (
                  <Button variant="outline" className={ACTION} disabled={busy !== null} onClick={() => void addToPantry()}>
                    {busy === 'pantry' ? <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> : <Package className="mr-2 h-5 w-5" aria-hidden />}
                    Add to pantry
                  </Button>
                )}
                {canEdit && (
                  <Button variant="outline" className={ACTION} onClick={() => { const target = item; close(); onEdit(target); }}>
                    <Edit className="mr-2 h-5 w-5" aria-hidden /> Edit
                  </Button>
                )}
                {canDelete && (
                  <Button variant="outline" className={`${ACTION} text-destructive`} onClick={() => { const target = item; close(); onDelete(target); }}>
                    <Trash2 className="mr-2 h-5 w-5" aria-hidden /> Delete
                  </Button>
                )}
                {!canEdit && !canDelete && <p className="text-sm text-muted-foreground">You can view saved products. Ask an admin for shopping access to use them.</p>}
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
