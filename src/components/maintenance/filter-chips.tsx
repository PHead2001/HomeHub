'use client';

import { cn } from '@/lib/utils';
import type { FilterChip } from '@/lib/maintenance/filters';

/**
 * One scrollable row of filter chips (MA-21): "All" plus one chip per value with
 * its count. Each chip is a toggle button (`aria-pressed`) at least
 * `--target-min` tall (44 px, 48 px on touch screens); choosing the selected chip
 * again clears the filter. Presentational: the page owns the URL state.
 */
export function FilterChips({
  label,
  chips,
  selected,
  onSelect,
  allLabel = 'All',
  className,
}: {
  /** Group name read by screen readers, e.g. "Location". */
  label: string;
  chips: readonly FilterChip[];
  /** The selected chip's value (compared ignoring case), or null for All. */
  selected: string | null;
  onSelect: (value: string | null) => void;
  allLabel?: string;
  className?: string;
}) {
  const selectedKey = selected?.trim().toLowerCase() ?? null;
  const chipClass = (pressed: boolean) =>
    cn(
      'inline-flex min-h-[var(--target-min)] min-w-[var(--target-min)] shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm font-medium transition-ui',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      pressed ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:bg-accent hover:text-accent-foreground',
    );

  return (
    <div role="group" aria-label={label} className={cn('-mx-1 flex gap-2 overflow-x-auto px-1 py-1 [scrollbar-width:thin]', className)}>
      <button type="button" aria-pressed={selectedKey === null} className={chipClass(selectedKey === null)} onClick={() => onSelect(null)}>
        {allLabel}
      </button>
      {chips.map((chip) => {
        const pressed = selectedKey === chip.value.trim().toLowerCase();
        return (
          <button
            key={chip.value}
            type="button"
            aria-pressed={pressed}
            aria-label={`${chip.label}, ${chip.count}`}
            className={chipClass(pressed)}
            onClick={() => onSelect(pressed ? null : chip.value)}
          >
            <span>{chip.label}</span>
            <span aria-hidden className={cn('tabular-nums', pressed ? 'opacity-80' : 'text-muted-foreground')}>{chip.count}</span>
          </button>
        );
      })}
    </div>
  );
}
