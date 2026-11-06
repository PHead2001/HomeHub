'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { collection, doc, query, setDoc } from 'firebase/firestore';
import { CheckCircle2, CloudOff, Link2, Loader2, Minus, Plus } from 'lucide-react';
import { categorizeGroceryItem } from '@/ai/flows/categorize-grocery-item-flow';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { LoginDialog } from '@/components/login-dialog';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { awaitWriteUnlessOffline, getDocOfflineAware, getDocsOfflineAware, isBrowserOffline } from '@/lib/firestore-offline';
import { MAX_ITEM_NAME_LENGTH, type SharedContent } from '@/lib/share-target';
import { resolveShoppingCategory } from '@/lib/shopping-categorization';
import { DEFAULT_SHOPPING_CATEGORIES, buildShoppingListItem, normalizeStoredCategories } from '@/lib/shopping-items';
import type { ShoppingList } from '@/lib/types';

type SaveResult = { listId: string; listName: string; itemName: string; queued: boolean };

function SharedPreview({ shared }: { shared: SharedContent }) {
  if (!shared.title && !shared.text && !shared.url) {
    return <p className="text-sm text-muted-foreground">Nothing was shared. You can still type an item below.</p>;
  }
  return (
    <div className="rounded-md border bg-secondary/40 p-3 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shared with HomeHub</p>
      {shared.title && <p className="mt-1 break-words font-medium">{shared.title}</p>}
      {shared.text && shared.text !== shared.title && (
        <p className="mt-1 line-clamp-3 break-words text-muted-foreground">{shared.text}</p>
      )}
      {shared.url && (
        <p className="mt-1 flex min-w-0 items-center gap-1 text-muted-foreground">
          <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{shared.url}</span>
        </p>
      )}
    </div>
  );
}

function StateCard({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-headline text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children && <CardContent className="space-y-4">{children}</CardContent>}
    </Card>
  );
}

/**
 * Share-target confirm flow: the signed-in member reviews the shared text, picks
 * one of the household's shopping lists, and explicitly confirms before a single
 * item is written. Uses the same item contract as the Shopping Lists tab.
 */
export function ShareTargetClient({ shared }: { shared: SharedContent }) {
  const { currentUser, currentMember, permissions, loading, householdLoading } = useAuth();
  const { toast } = useToast();
  const householdId = currentUser?.householdId ?? null;
  const isPending = currentMember?.role === 'newuser';
  const canEdit = Boolean(householdId && currentMember && !isPending && permissions['shopping.view'] && permissions['shopping.edit']);

  const [lists, setLists] = useState<ShoppingList[] | null>(null);
  const [listsFailed, setListsFailed] = useState(false);
  const [selectedListId, setSelectedListId] = useState('');
  const [itemName, setItemName] = useState(shared.itemName);
  const [quantity, setQuantity] = useState(1);
  const [saveLink, setSaveLink] = useState(Boolean(shared.url));
  const [isSaving, setIsSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);

  useEffect(() => {
    if (!householdId || !canEdit) return;
    let cancelled = false;
    getDocsOfflineAware(query(collection(db, 'households', householdId, 'shopping-lists')))
      .then((snapshot) => {
        if (cancelled) return;
        const loaded = snapshot.docs
          .map((listDoc) => ({ id: listDoc.id, ...listDoc.data() } as ShoppingList))
          .sort((a, b) => a.name.localeCompare(b.name));
        setLists(loaded);
        if (loaded.length === 1) setSelectedListId(loaded[0].id);
      })
      .catch(() => {
        if (!cancelled) setListsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [householdId, canEdit]);

  const selectedList = useMemo(() => lists?.find((list) => list.id === selectedListId) ?? null, [lists, selectedListId]);
  const trimmedName = itemName.trim();

  const handleConfirm = async () => {
    if (!householdId || !selectedList || !trimmedName || isSaving) return;
    setIsSaving(true);
    try {
      const categoriesSnapshot = await getDocOfflineAware(
        doc(db, 'households', householdId, 'shopping-lists', selectedList.id, 'config', 'categories')
      ).catch(() => null);
      const categories = (categoriesSnapshot?.exists() ? normalizeStoredCategories(categoriesSnapshot.data()) : null)
        ?? DEFAULT_SHOPPING_CATEGORIES;
      const { category } = await resolveShoppingCategory({
        itemName: trimmedName,
        categories,
        // Offline there is no model to ask; save under Other like any AI fallback.
        selectedCategory: isBrowserOffline() ? 'Other' : undefined,
        categorize: async (categorizeInput) => unwrapAiActionResult(await categorizeGroceryItem(
          categorizeInput,
          await getAiActionContext(householdId)
        )),
      });
      const { itemId, data } = buildShoppingListItem({
        name: trimmedName,
        quantity,
        category,
        sourceUrl: saveLink ? shared.url : undefined,
      });
      const saved = await awaitWriteUnlessOffline(
        setDoc(doc(db, 'households', householdId, 'shopping-lists', selectedList.id, 'items', itemId), data),
        () => toast({ variant: 'destructive', title: 'Could not sync item', description: `${trimmedName} could not be saved when the connection returned.` }),
      );
      setResult({ listId: selectedList.id, listName: selectedList.name, itemName: trimmedName, queued: saved === 'queued' });
    } catch {
      toast({ variant: 'destructive', title: 'Could not add the item', description: 'Please try again.' });
    } finally {
      setIsSaving(false);
    }
  };

  if (loading || (currentUser && householdLoading)) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!currentUser) {
    return (
      <StateCard title="Sign in to save this" description="Log in to HomeHub to add what you shared to a household shopping list.">
        <SharedPreview shared={shared} />
        <LoginDialog>
          <Button className="w-full sm:w-auto">Login</Button>
        </LoginDialog>
      </StateCard>
    );
  }

  if (!householdId || !currentMember) {
    return (
      <StateCard title="Join a household first" description="Shopping lists belong to a household. Create or join one, then share again.">
        <SharedPreview shared={shared} />
      </StateCard>
    );
  }

  if (!canEdit) {
    return (
      <StateCard
        title="You can't add shopping items"
        description={isPending
          ? 'Your membership is waiting for approval.'
          : 'Your household role does not allow editing shopping lists. Ask a household admin for access.'}
      >
        <SharedPreview shared={shared} />
      </StateCard>
    );
  }

  if (result) {
    return (
      <StateCard
        title={result.queued ? 'Saved offline' : 'Added to your list'}
        description={result.queued
          ? `${result.itemName} will be added to ${result.listName} when you're back online.`
          : `${result.itemName} was added to ${result.listName}.`}
      >
        <div className="flex items-center gap-2 text-sm" role="status">
          {result.queued
            ? <CloudOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            : <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />}
          <span>{result.queued ? 'Waiting to sync' : 'Saved'}</span>
        </div>
        <Button asChild className="w-full sm:w-auto">
          <Link href="/shopping">Open shopping lists</Link>
        </Button>
      </StateCard>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-headline text-xl">Review and choose a list</CardTitle>
        <CardDescription>Nothing is saved until you tap Add to list.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SharedPreview shared={shared} />

        <div className="space-y-2">
          <Label htmlFor="share-item-name">Item name</Label>
          <Input
            id="share-item-name"
            value={itemName}
            maxLength={MAX_ITEM_NAME_LENGTH}
            onChange={(event) => setItemName(event.target.value)}
            placeholder="e.g. Olive Oil"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="share-item-quantity">Quantity</Label>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="icon" className="h-10 w-10" aria-label="Decrease item quantity" disabled={quantity <= 1} onClick={() => setQuantity((value) => Math.max(1, value - 1))}>
              <Minus className="h-4 w-4" />
            </Button>
            <Input
              id="share-item-quantity"
              type="number"
              min={1}
              className="w-20 text-center"
              value={quantity}
              onChange={(event) => setQuantity(Math.max(1, Math.floor(Number(event.target.value)) || 1))}
            />
            <Button type="button" variant="outline" size="icon" className="h-10 w-10" aria-label="Increase item quantity" onClick={() => setQuantity((value) => value + 1)}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {shared.url && (
          <div className="flex items-start gap-2">
            <Checkbox id="share-save-link" checked={saveLink} onCheckedChange={(checked) => setSaveLink(checked === true)} />
            <Label htmlFor="share-save-link" className="leading-snug">Save the link with the item</Label>
          </div>
        )}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Shopping list</legend>
          {listsFailed && <p className="text-sm text-destructive">Could not load your shopping lists. Check your connection and try again.</p>}
          {!listsFailed && lists === null && <Skeleton className="h-20 w-full" />}
          {lists && lists.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Your household has no shopping lists yet. <Link href="/shopping" className="underline underline-offset-4">Create one</Link>, then share again.
            </p>
          )}
          {lists && lists.length > 0 && (
            <RadioGroup value={selectedListId} onValueChange={setSelectedListId} className="gap-2">
              {lists.map((list) => (
                <Label
                  key={list.id}
                  htmlFor={`share-list-${list.id}`}
                  className="flex cursor-pointer items-center gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary"
                >
                  <RadioGroupItem id={`share-list-${list.id}`} value={list.id} />
                  <span className="min-w-0 flex-1 break-words">{list.name}</span>
                  <span className="text-xs text-muted-foreground">{list.type}</span>
                </Label>
              ))}
            </RadioGroup>
          )}
        </fieldset>
      </CardContent>
      <CardFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link href="/shopping">Cancel</Link>
        </Button>
        <Button className="w-full sm:w-auto" onClick={handleConfirm} disabled={!selectedList || !trimmedName || isSaving}>
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Add to list
        </Button>
      </CardFooter>
    </Card>
  );
}
