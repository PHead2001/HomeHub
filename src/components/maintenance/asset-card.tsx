'use client';

import { useState, type ElementType } from 'react';
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
import { HealthRing } from './health-ring';

const CATEGORY_ICONS: Record<HomeAssetCategory, ElementType> = {
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
 * Photo-first asset card (H30). The newest image attachment fills a fixed 80 px
 * band: a blurred, scaled copy covers the band and the sharp photo sits on top
 * uncropped (`object-contain`), so portrait and landscape shots both read. With no
 * photo, or when it fails to load, the band shows the category icon on a
 * token gradient. The band height is fixed, so the card never shifts when the
 * image loads, and cards keep their content height (B7).
 */
export function AssetCard({
  asset,
  photo,
  health,
  selected,
  onSelect,
}: {
  asset: HomeAsset;
  photo: MaintenanceAttachment | null;
  health?: HealthResult;
  selected: boolean;
  onSelect: () => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = photo?.downloadUrl && photo.downloadUrl !== failedUrl ? photo.downloadUrl : null;
  const Icon = CATEGORY_ICONS[asset.category] || Package;
  const status = statusLabel(asset.status);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      data-testid={`asset-card-${asset.id}`}
      className={cn(
        'glow-card flex flex-col overflow-hidden rounded-lg border bg-card text-left shadow-raised transition-ui hover:bg-accent',
        selected && 'border-primary',
      )}
    >
      <div aria-hidden className="relative h-20 w-full shrink-0 overflow-hidden bg-muted" data-asset-photo={url ? 'image' : 'fallback'}>
        {url ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded Storage URL; no fixed remote pattern */}
            <img src={url} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-xl" loading="lazy" decoding="async" />
            {/* eslint-disable-next-line @next/next/no-img-element -- user-uploaded Storage URL; no fixed remote pattern */}
            <img
              src={url}
              alt=""
              className="relative h-full w-full object-contain"
              loading="lazy"
              decoding="async"
              onError={() => setFailedUrl(url)}
            />
          </>
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/20 via-muted to-secondary">
            <Icon className="h-8 w-8 text-primary" />
          </div>
        )}
      </div>
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <p className="font-headline font-semibold">{asset.name}</p>
          <p className="text-sm text-muted-foreground">
            {[asset.category, asset.location].filter(Boolean).join(' · ')}
          </p>
          {status && (
            <Badge variant={asset.status === 'needs_attention' ? 'destructive' : 'outline'} className="mt-2">{status}</Badge>
          )}
        </div>
        {health && <HealthRing score={health.score} band={health.band} label={`${asset.name} health`} />}
      </div>
    </button>
  );
}
