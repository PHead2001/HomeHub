'use client';

import type { ElementType, MouseEvent } from 'react';
import {
  Droplets,
  Hammer,
  Lightbulb,
  Package,
  Thermometer,
  Trees,
  WashingMachine,
  Wifi,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { HealthResult } from '@/lib/maintenance/health';
import type { HomeAsset, HomeAssetCategory, MaintenanceAttachment } from '@/lib/types';
import { cn } from '@/lib/utils';
import type { WarrantyCountdown } from '@/lib/maintenance/warranty';
import { BrandLogo } from '@/components/brand/brand-logo';
import { HealthRing } from './health-ring';
import { PhotoBand } from './photo-band';
import { WarrantyRing } from './warranty-ring';

export const CATEGORY_ICONS: Record<HomeAssetCategory, ElementType> = {
  HVAC: Thermometer,
  Appliance: WashingMachine,
  Plumbing: Droplets,
  Electrical: Zap,
  Network: Wifi,
  'Smart Home': Lightbulb,
  'Lawn / Outdoor': Trees,
  Tool: Hammer,
  Other: Package,
};

const statusLabel = (status: HomeAsset['status']) => (status === 'needs_attention' ? 'Needs attention' : status === 'retired' ? 'Retired' : null);

/**
 * Photo-first asset card (H30). The newest image attachment fills the photo band
 * over a blurred copy of itself; with no photo the band shows the category icon.
 * The brand mark (logo or monogram badge) appears once, beside the title, named
 * for assistive tech. Cards keep their content height (B7). Beside the health ring,
 * a warranty countdown ring shows the days left of the warranty term (H10).
 */
export function AssetCard({
  asset,
  photo,
  health,
  warranty,
  selected,
  onSelect,
}: {
  asset: HomeAsset;
  photo: MaintenanceAttachment | null;
  health?: HealthResult;
  /** Warranty countdown (H10); omitted when the asset has no warranty end date. */
  warranty?: WarrantyCountdown | null;
  selected: boolean;
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = CATEGORY_ICONS[asset.category] || Package;
  const status = statusLabel(asset.status);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      data-testid={`asset-card-${asset.id}`}
      className={cn(
        'glow-card flex w-full flex-col overflow-hidden rounded-lg border bg-card text-left shadow-raised transition-ui hover:bg-accent',
        selected && 'border-primary',
      )}
    >
      <PhotoBand
        kind="asset"
        url={photo?.downloadUrl}
        fallback={<Icon className="h-8 w-8" />}
      />
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* Named after the brand: the card text does not otherwise show it. */}
            <BrandLogo brand={asset.brand} size="sm" className="text-muted-foreground" />
            <p className="min-w-0 font-headline font-semibold">{asset.name}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            {[asset.category, asset.location].filter(Boolean).join(' · ')}
          </p>
          {status && (
            <Badge variant={asset.status === 'needs_attention' ? 'destructive' : 'outline'} className="mt-2">{status}</Badge>
          )}
        </div>
        {(health || warranty) && (
          <div className="flex shrink-0 items-center gap-1.5">
            {warranty && <WarrantyRing countdown={warranty} name={asset.name} />}
            {health && <HealthRing score={health.score} band={health.band} label={`${asset.name} health`} />}
          </div>
        )}
      </div>
    </button>
  );
}
