'use client';

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hasActiveFilters, MAX_QUERY_LENGTH, type FilterChip, type MaintenanceFilters } from '@/lib/maintenance/filters';
import { FilterChips } from './filter-chips';

/** How long typing waits before the search is written to the URL (one history write per pause). */
const SEARCH_DELAY_MS = 250;

/**
 * Search, location and category for Home Assets, Vehicles, Reminders and Logs (MA-21). The
 * values live in the URL (`?q=`, `?location=`, `?category=`, written by `onChange` with the
 * other parameters kept). Typing is local and written after a short pause, so a keystroke
 * re-renders only this bar.
 */
export const MaintenanceFilterBar = React.memo(function MaintenanceFilterBar({
  filters,
  locationChips,
  categoryChips,
  onChange,
}: {
  filters: MaintenanceFilters;
  locationChips: FilterChip[];
  categoryChips: FilterChip[];
  onChange: (filters: MaintenanceFilters) => void;
}) {
  const [text, setText] = React.useState(filters.q);
  // A new value from the URL (Back, a link, Clear) replaces what is typed.
  const [urlQ, setUrlQ] = React.useState(filters.q);
  if (urlQ !== filters.q) {
    setUrlQ(filters.q);
    // Our own write comes back trimmed: keep what is typed (a trailing space mid-word).
    if (text.trim() !== filters.q) setText(filters.q);
  }
  const latest = React.useRef(filters);
  React.useEffect(() => { latest.current = filters; });
  React.useEffect(() => {
    if (text.trim() === urlQ.trim()) return;
    const timer = window.setTimeout(() => onChange({ ...latest.current, q: text }), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, urlQ, onChange]);

  const active = hasActiveFilters(filters);
  return (
    <div className="space-y-2" data-testid="maintenance-filters">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-60">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={text}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search names, brands, notes…"
            aria-label="Search maintenance"
            className="pl-9"
          />
        </div>
        {active && (
          <Button type="button" variant="ghost" onClick={() => { setText(''); onChange({ location: null, category: null, q: '' }); }}>
            <X aria-hidden className="mr-1 h-4 w-4" />
            Clear filters
          </Button>
        )}
      </div>
      {locationChips.length > 0 && (
        <FilterChips
          label="Location"
          chips={locationChips}
          selected={filters.location}
          allLabel="All locations"
          onSelect={(location) => onChange({ ...filters, location })}
        />
      )}
      {categoryChips.length > 1 && (
        <FilterChips
          label="Category"
          chips={categoryChips}
          selected={filters.category}
          allLabel="All categories"
          onSelect={(category) => onChange({ ...filters, category })}
        />
      )}
    </div>
  );
});
