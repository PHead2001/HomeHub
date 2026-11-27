'use client';

import { Lightbulb, Loader2, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { describeEntityState, entityName, formatEntityTime, sinceLabel, type HomeAssistantEntitySummary } from '@/lib/automation/entities';
import { controlFor } from '@/lib/automation/controls';
import { mayPlaceOnHouse } from '@/lib/automation/config';

const STATE_TONE_CLASSES = {
  on: 'bg-success/15 text-success',
  off: 'bg-muted text-muted-foreground',
  alert: 'bg-warning/15 text-warning',
  unavailable: 'border border-dashed text-muted-foreground',
  value: 'bg-secondary text-secondary-foreground',
} as const;

export type RoomOption = { id: string; name: string };

/**
 * One device (AU-3, AU-8, AU-14): its name, its state in plain words with how long it has
 * been that way, and, for people allowed to, a big on/off or Activate button (lights,
 * fans and scenes only). The entity id, last change, favourite pin and room link sit in
 * a details section.
 */
export function EntityTile({
  entity,
  timeZone,
  now,
  favorite,
  canManage,
  canControl,
  rooms,
  roomId,
  pending,
  onToggleFavorite,
  onRoomChange,
  onControl,
}: {
  entity: HomeAssistantEntitySummary;
  timeZone: string;
  now: Date;
  favorite: boolean;
  canManage: boolean;
  canControl: boolean;
  rooms: RoomOption[];
  roomId: string | null;
  pending: boolean;
  onToggleFavorite: () => void;
  onRoomChange: (roomId: string | null) => void;
  onControl: (desired: 'on' | 'off') => void;
}) {
  const name = entityName(entity);
  const view = describeEntityState(entity, timeZone);
  const since = sinceLabel(entity.last_changed, now);
  const control = canControl ? controlFor(entity) : null;
  const changedAt = entity.last_changed ? formatEntityTime(entity.last_changed, timeZone) : null;
  const placeable = canManage && rooms.length > 0 && mayPlaceOnHouse(entity.entity_id);
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
      {control && (
        control.kind === 'scene' ? (
          <Button size="lg" variant="secondary" className="w-full" disabled={pending} onClick={() => onControl('on')} aria-label={`Activate ${name}`}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lightbulb className="h-4 w-4" />} Activate
          </Button>
        ) : (
          <Button
            size="lg"
            variant={control.on ? 'default' : 'outline'}
            className="w-full"
            disabled={pending}
            aria-pressed={control.on}
            aria-label={`${name}: turn ${control.on ? 'off' : 'on'}`}
            onClick={() => onControl(control.on ? 'off' : 'on')}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lightbulb className="h-4 w-4" />} {control.on ? 'Turn off' : 'Turn on'}
          </Button>
        )
      )}
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
          {placeable && (
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Show on the house in
              <select
                className="h-[var(--target-min)] rounded-md border bg-background px-2 text-sm text-foreground"
                value={roomId ?? ''}
                onChange={(event) => onRoomChange(event.target.value || null)}
              >
                <option value="">Not on the house</option>
                {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
              </select>
            </label>
          )}
        </div>
      </details>
    </li>
  );
}
