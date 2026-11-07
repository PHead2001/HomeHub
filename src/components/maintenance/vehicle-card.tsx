'use client';

import { forwardRef, type MouseEvent } from 'react';
import { Car } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { BrandLogo } from '@/components/brand/brand-logo';
import type { HealthResult } from '@/lib/maintenance/health';
import type { MaintenanceAttachment, Vehicle } from '@/lib/types';
import { cn } from '@/lib/utils';
import { HealthRing } from './health-ring';
import { Odometer } from './odometer';
import { PhotoBand } from './photo-band';

const describe = (vehicle: Vehicle) => [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle';

/**
 * Photo-first vehicle card (H30), the same treatment as asset cards: the newest
 * photo attached to the vehicle over a blurred copy of itself, or the make's logo
 * (monogram badge when there is no artwork), or a car icon. The make is shown as
 * text, so the logo is decorative. Sold and retired vehicles render muted with
 * their status instead of mileage.
 */
export const VehicleCard = forwardRef<HTMLButtonElement, {
  vehicle: Vehicle;
  photo: MaintenanceAttachment | null;
  health?: HealthResult;
  selected: boolean;
  inactive?: boolean;
  statusLabel?: string;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
  style?: React.CSSProperties;
}>(function VehicleCard({ vehicle, photo, health, selected, inactive = false, statusLabel, onSelect, style }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      data-testid={`vehicle-card-${vehicle.id}`}
      style={style}
      className={cn(
        'glow-card flex w-full flex-col overflow-hidden rounded-lg border text-left transition-ui hover:bg-accent',
        inactive ? 'bg-muted/30' : 'bg-card shadow-raised',
        selected && 'border-primary',
      )}
    >
      <PhotoBand
        kind="vehicle"
        url={photo?.downloadUrl}
        fallback={<BrandLogo brand={vehicle.make} size="lg" decorative fallback={<Car className="h-8 w-8" />} />}
      />
      <div className="w-full p-4 pt-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BrandLogo brand={vehicle.make} size="sm" decorative className="text-muted-foreground" />
              <p className="min-w-0 font-headline font-semibold">{vehicle.nickname}</p>
            </div>
            <p className="text-sm text-muted-foreground">{describe(vehicle)}</p>
          </div>
          {inactive
            ? statusLabel && <Badge variant="outline">{statusLabel}</Badge>
            : health && <HealthRing score={health.score} band={health.band} label={`${vehicle.nickname} health`} />}
        </div>
        {!inactive && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {typeof vehicle.currentMileage === 'number' ? <Odometer miles={vehicle.currentMileage} /> : <span>Mileage not recorded</span>}
            {vehicle.status === 'needs_attention' && <Badge variant="destructive">Needs attention</Badge>}
          </div>
        )}
      </div>
    </button>
  );
});
