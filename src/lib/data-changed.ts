/**
 * A tiny cross-module "data changed" signal. Writes made outside a module's own
 * screen (the command palette's quick add) announce themselves here, so module
 * screens that load with one-time reads can refresh the affected data silently.
 * Screens with live listeners do not need it.
 */
export const DATA_CHANGED_EVENT = 'homehub:data-changed';

export type DataChangedModule = 'shopping' | 'chores' | 'pets' | 'maintenance';

export type DataChangedDetail = {
  module: DataChangedModule;
  householdId: string;
  listId?: string;
  petId?: string;
  choreId?: string;
};

/** Announces a confirmed write. Safe on the server (no-op). */
export function notifyDataChanged(detail: DataChangedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<DataChangedDetail>(DATA_CHANGED_EVENT, { detail }));
}

/**
 * Subscribes to changes for one module of one household; returns the unsubscribe.
 * Events for other modules or households are ignored.
 */
export function onDataChanged(
  module: DataChangedModule,
  householdId: string,
  handler: (detail: DataChangedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<DataChangedDetail>).detail;
    if (detail && detail.module === module && detail.householdId === householdId) handler(detail);
  };
  window.addEventListener(DATA_CHANGED_EVENT, listener);
  return () => window.removeEventListener(DATA_CHANGED_EVENT, listener);
}
