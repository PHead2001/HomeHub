'use client';

import { useCallback, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ShoppingListClient } from './shopping-list-client';
import { PantryInventoryClient } from '@/components/pantry-inventory-client';
import { ClipboardList, Archive } from 'lucide-react';
import { parseShoppingUrlState, shoppingHref, type ShoppingTab } from '@/lib/shopping/url-state';

/**
 * The Shopping Center: Shopping Lists and Pantry Inventory tabs. The open tab and
 * list live in the URL (`/shopping?list=weekly-groceries`, `/shopping?tab=pantry`),
 * so refresh keeps your place, Back returns to the overview, and a list can be
 * linked. The screen is derived from `useSearchParams()` on every render (never a
 * one-time read), so Back/Forward, Next.js `<Link>` navigation (the header and tab
 * bar "Shopping" links) and our own shallow `history` updates all stay in sync.
 * Ticking an item never switches tabs; the pantry is offered at the end of a trip
 * or when clearing purchased items.
 */
export function ShoppingCenterClient() {
  const searchParams = useSearchParams();
  const pathname = usePathname() || '/shopping';
  const state = parseShoppingUrlState(searchParams);

  // The list id this component last pushed onto history, so "Back to all lists"
  // can step back (instead of stacking another entry) when that entry is current.
  const pushedListRef = useRef<string | null>(null);

  // Shallow URL updates: Next.js syncs useSearchParams with history.pushState/replaceState.
  const go = useCallback((next: { tab: ShoppingTab; listId: string | null }, mode: 'push' | 'replace') => {
    const href = shoppingHref(pathname, new URLSearchParams(window.location.search), next);
    if (href === `${window.location.pathname}${window.location.search}`) return;
    if (mode === 'push') window.history.pushState(null, '', href);
    else window.history.replaceState(null, '', href);
  }, [pathname]);

  // Opening a list adds a history entry (Back returns to the overview); leaving one replaces it.
  const handleSelectList = useCallback((listId: string | null) => {
    const current = parseShoppingUrlState(new URLSearchParams(window.location.search));
    if (!listId && current.listId && pushedListRef.current === current.listId) {
      pushedListRef.current = null;
      window.history.back();
      return;
    }
    go({ tab: 'lists', listId }, listId ? 'push' : 'replace');
    pushedListRef.current = listId;
  }, [go]);

  const handleTabChange = useCallback((value: string) => {
    pushedListRef.current = null;
    go(value === 'inventory' ? { tab: 'inventory', listId: null } : { tab: 'lists', listId: null }, 'replace');
  }, [go]);

  const openPantry = useCallback(() => {
    pushedListRef.current = null;
    go({ tab: 'inventory', listId: null }, 'push');
  }, [go]);

  // The one-shot `?quickAdd=1` request is consumed by replacing the entry, so Back
  // never reopens the dialog.
  const handleQuickAddHandled = useCallback((listId: string | null) => {
    pushedListRef.current = null;
    go({ tab: 'lists', listId }, 'replace');
  }, [go]);

  return (
    <Tabs value={state.tab} onValueChange={handleTabChange} className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="lists"><ClipboardList className="mr-2" aria-hidden /> Shopping Lists</TabsTrigger>
        <TabsTrigger value="inventory"><Archive className="mr-2" aria-hidden /> Pantry Inventory</TabsTrigger>
      </TabsList>
      {/* Both tabs stay mounted (SH-25b): switching keeps their live listeners and
          state instead of re-reading everything; the inactive one is hidden.
          min-h keeps the page height steady while a tab's content loads. */}
      <TabsContent value="lists" forceMount className="min-h-[24rem] data-[state=inactive]:hidden">
        <ShoppingListClient
          selectedListId={state.listId}
          onSelectList={handleSelectList}
          onOpenPantry={openPantry}
          quickAddRequested={state.quickAdd}
          onQuickAddHandled={handleQuickAddHandled}
        />
      </TabsContent>
      <TabsContent value="inventory" forceMount className="min-h-[24rem] data-[state=inactive]:hidden">
        <PantryInventoryClient />
      </TabsContent>
    </Tabs>
  );
}
