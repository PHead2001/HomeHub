/**
 * The Shopping Center's URL state: `?tab=pantry` opens the Pantry Inventory tab,
 * `?list=<id>` opens a list, `?quickAdd=1` (home-screen shortcut) asks for the
 * add-item dialog. The screen is always derived from the current search params
 * (`useSearchParams`), so browser Back/Forward, Next.js `<Link>` navigation and
 * shallow `history` updates all keep the screen and the address bar in step.
 */

export type ShoppingTab = 'lists' | 'inventory';
export type ShoppingUrlState = { tab: ShoppingTab; listId: string | null; quickAdd: boolean };

type ParamsLike = Pick<URLSearchParams, 'get' | 'toString'>;

export function parseShoppingUrlState(params: ParamsLike | null | undefined): ShoppingUrlState {
  const tab: ShoppingTab = params?.get('tab') === 'pantry' ? 'inventory' : 'lists';
  const list = params?.get('list')?.trim() || null;
  return {
    tab,
    listId: tab === 'lists' ? list : null,
    quickAdd: params?.get('quickAdd') === '1',
  };
}

/**
 * The href for a tab/list on `pathname`, keeping unrelated params. `quickAdd` is
 * dropped unless `keepQuickAdd` is set (it is a one-shot request).
 */
export function shoppingHref(
  pathname: string,
  current: ParamsLike | null | undefined,
  next: { tab: ShoppingTab; listId: string | null },
  { keepQuickAdd = false }: { keepQuickAdd?: boolean } = {},
): string {
  const params = new URLSearchParams(current?.toString() ?? '');
  params.delete('tab');
  params.delete('list');
  if (!keepQuickAdd) params.delete('quickAdd');
  if (next.tab === 'inventory') params.set('tab', 'pantry');
  else if (next.listId) params.set('list', next.listId);
  const search = params.toString();
  return `${pathname}${search ? `?${search}` : ''}`;
}
