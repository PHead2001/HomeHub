import type { ReactNode } from 'react';

/** Pets page header: title left, page actions in the same row (as Shopping and Maintenance). */
export function PetsPageHeader({ action }: { action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="w-full min-w-0">
        <h1 className="font-headline text-3xl font-bold tracking-tight">Your Pets</h1>
        <p className="text-muted-foreground">Feedings, medication and care for every pet, at a glance.</p>
      </div>
      {action ? <div className="w-full shrink-0 sm:w-auto">{action}</div> : null}
    </div>
  );
}
