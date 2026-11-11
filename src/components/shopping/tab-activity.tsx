'use client';

import { createContext, useContext, useState, type ComponentProps, type ReactNode } from 'react';
import { DropdownMenu } from '@/components/ui/dropdown-menu';
import { deactivated } from '@/lib/shopping/live-state';

/*
 * Both Shopping Center tabs stay mounted (SH-25b), but their dialogs, menus and
 * peek cards render through portals outside the hidden panel. A tab that becomes
 * inactive (a tab click, or browser Back/Forward changing `?tab=`) closes every
 * overlay it owns, in the render where it turns inactive, so nothing stays on
 * screen or traps focus over the other tab. Its data listeners keep running.
 */

const TabActiveContext = createContext(true);

/** Marks a tab's content as active or not. */
export function TabActivity({ active, children }: { active: boolean; children: ReactNode }) {
  return <TabActiveContext.Provider value={active}>{children}</TabActiveContext.Provider>;
}

/** Whether the enclosing tab is the one shown (true outside a tab). */
export const useTabActive = () => useContext(TabActiveContext);

/**
 * Calls `onDeactivate` during the render in which the enclosing tab turns
 * inactive (use it to close the component's own overlays). Returns the flag.
 */
export function useOnTabDeactivate(onDeactivate: () => void): boolean {
  const active = useTabActive();
  const [previous, setPrevious] = useState(active);
  if (previous !== active) {
    setPrevious(active);
    if (deactivated(previous, active)) onDeactivate();
  }
  return active;
}

/** A `DropdownMenu` that closes when its tab becomes inactive. */
export function TabDropdownMenu({ onOpenChange, ...props }: Omit<ComponentProps<typeof DropdownMenu>, 'open' | 'defaultOpen'>) {
  const [open, setOpen] = useState(false);
  const active = useOnTabDeactivate(() => setOpen(false));
  return (
    <DropdownMenu
      {...props}
      open={open && active}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    />
  );
}
