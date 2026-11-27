'use client';

import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { describeEntityState, entityName, formatEntityTime, sinceLabel, type HomeAssistantEntitySummary } from '@/lib/automation/entities';

const STATE_TONE_CLASSES = {
  on: 'bg-success/15 text-success',
  off: 'bg-muted text-muted-foreground',
  alert: 'bg-warning/15 text-warning',
  unavailable: 'border border-dashed text-muted-foreground',
  value: 'bg-secondary text-secondary-foreground',
} as const;

/**
 * One device (AU-3, AU-8): its name and its state in plain words with how long it has
 * been that way. The entity id, last change, favourite pin and room link sit in a
 * details section (rooms come with AU-13).
 */
export function EntityTile({
  entity,
  timeZone,
  now,
  favorite,
  canManage,
  onToggleFavorite,
}: {
  entity: HomeAssistantEntitySummary;
  timeZone: string;
  now: Date;
  favorite: boolean;
  canManage: boolean;
  onToggleFavorite: () => void;
}) {
  const name = entityName(entity);
  const view = describeEntityState(entity, timeZone);
  const since = sinceLabel(entity.last_changed, now);
  const changedAt = entity.last_changed ? formatEntityTime(entity.last_changed, timeZone) : null;
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3" data-entity-id={entity.entity_id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">
            <span className={cn('mr-1.5 inline-block rounded-full px-2 py-0.5 text-xs font-semibold', STATE_TONE_CLASSES[view.tone])}>{view.label}</span>
            {since && <span>for {since}</span>}
          </p>
        </div>
        {favorite && <Star aria-label="Favourite" className="h-4 w-4 shrink-0 fill-warning text-warning" />}
      </div>
      <details className="text-sm">
        <summary className="flex min-h-[var(--target-min)] cursor-pointer items-center text-muted-foreground">Details</summary>
        <div className="space-y-2 pb-1">
          <p className="break-all font-code text-xs text-muted-foreground">{entity.entity_id}</p>
          {changedAt && <p className="text-xs text-muted-foreground">Last changed {changedAt}</p>}
          {canManage && (
            <Button variant="outline" size="sm" onClick={onToggleFavorite} aria-pressed={favorite}>
              <Star className={cn('h-4 w-4', favorite && 'fill-warning text-warning')} /> {favorite ? 'Unpin from top' : 'Pin to top'}
            </Button>
          )}
        </div>
      </details>
    </li>
  );
}
