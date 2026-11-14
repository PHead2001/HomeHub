import type { ReactNode } from 'react';

/**
 * Pets page header: title left, page actions in the same row on every screen
 * (as Shopping and Maintenance; on phones too, PE-13b). The board hides the
 * subtitle (PE-9f).
 */
export function PetsPageHeader({ action, subtitle = true }: { action?: ReactNode; subtitle?: boolean }) {
  return (
    <div className={subtitle ? 'mb-8 flex flex-row items-start justify-between gap-4' : 'mb-4 flex flex-row items-center justify-between gap-4'}>
      <div className="min-w-0 flex-1">
        {/* Focusable by script only: focus lands here when a dialog's pet is gone (PE-20e). */}
        <h1 tabIndex={-1} data-pets-heading className="font-headline text-3xl font-bold tracking-tight focus:outline-none">Your Pets</h1>
        {subtitle && <p className="text-muted-foreground">Feedings, medication and care for every pet, at a glance.</p>}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
