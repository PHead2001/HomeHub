'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ShoppingListClient } from './shopping-list-client';
import { PantryInventoryClient } from '@/components/pantry-inventory-client';
import { ClipboardList, Archive } from 'lucide-react';

type ShoppingTab = 'lists' | 'inventory';

type ShoppingUrlState = { tab: ShoppingTab; listId: string | null };

/** Reads `?tab=pantry` and `?list=<id>` from the address bar. */
function readUrlState(): ShoppingUrlState {
  const params = new URLSearchParams(window.location.search);
  const tab: ShoppingTab = params.get('tab') === 'pantry' ? 'inventory' : 'lists';
  const list = params.get('list');
  return { tab, listId: tab === 'lists' && list ? list : null };
}

function urlFor(state: ShoppingUrlState): string {
  const params = new URLSearchParams(window.location.search);
  params.delete('tab');
  params.delete('list');
  if (state.tab === 'inventory') params.set('tab', 'pantry');
  else if (state.listId) params.set('list', state.listId);
  const search = params.toString();
  return `${window.location.pathname}${search ? `?${search}` : ''}`;
}

/**
 * The Shopping Center: Shopping Lists and Pantry Inventory tabs. The open tab and
 * list live in the URL (`/shopping?list=weekly-groceries`, `/shopping?tab=pantry`),
 * so refresh keeps your place, Back returns to the overview, and a list can be
 * linked. Ticking an item never switches tabs; the pantry is offered at the end
 * of a trip or when clearing purchased items.
 */
export function ShoppingCenterClient() {
  // Rendered only client-side (after sign-in), so the URL can seed the first render.
  const [state, setState] = useState<ShoppingUrlState>(() => (typeof window === 'undefined' ? { tab: 'lists', listId: null } : readUrlState()));

  // True while the current history entry is a list this component pushed, so
  // "Back to all lists" can step back instead of stacking another entry.
  const pushedListRef = useRef(false);

  useEffect(() => {
    const onPopState = () => {
      pushedListRef.current = false;
      setState(readUrlState());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((next: ShoppingUrlState, mode: 'push' | 'replace') => {
    setState(next);
    const url = urlFor(next);
    if (url === `${window.location.pathname}${window.location.search}`) return;
    // Next.js keeps its router in sync with these calls (shallow URL updates).
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  }, []);

  // Opening a list adds a history entry (Back returns to the overview); leaving one replaces it.
  const handleSelectList = useCallback((listId: string | null) => {
    if (!listId && pushedListRef.current) {
      pushedListRef.current = false;
      setState({ tab: 'lists', listId: null });
      window.history.back();
      return;
    }
    navigate({ tab: 'lists', listId }, listId ? 'push' : 'replace');
    if (listId) pushedListRef.current = true;
  }, [navigate]);

  const handleTabChange = useCallback((value: string) => {
    pushedListRef.current = false;
    navigate(value === 'inventory' ? { tab: 'inventory', listId: null } : { tab: 'lists', listId: null }, 'replace');
  }, [navigate]);

  const openPantry = useCallback(() => {
    pushedListRef.current = false;
    navigate({ tab: 'inventory', listId: null }, 'push');
  }, [navigate]);

  return (
    <Tabs value={state.tab} onValueChange={handleTabChange} className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="lists"><ClipboardList className="mr-2" aria-hidden /> Shopping Lists</TabsTrigger>
        <TabsTrigger value="inventory"><Archive className="mr-2" aria-hidden /> Pantry Inventory</TabsTrigger>
      </TabsList>
      {/* min-h keeps the page height steady while a tab's content loads. */}
      <TabsContent value="lists" className="min-h-[24rem]">
        <ShoppingListClient
          selectedListId={state.listId}
          onSelectList={handleSelectList}
          onOpenPantry={openPantry}
        />
      </TabsContent>
      <TabsContent value="inventory" className="min-h-[24rem]">
        <PantryInventoryClient />
      </TabsContent>
    </Tabs>
  );
}
