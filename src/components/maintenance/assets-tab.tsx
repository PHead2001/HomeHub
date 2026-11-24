'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
import type { useInPageMorph } from '@/components/shopping/use-in-page-morph';
import { Button } from '@/components/ui/button';
import { TabsContent } from '@/components/ui/tabs';
import { pickAssetPhoto } from '@/lib/maintenance/display';
import { healthKey } from '@/lib/maintenance/health';
import { warrantyCountdown } from '@/lib/maintenance/warranty';
import { morphStyle, sharedId } from '@/lib/motion';
import { AssetCard } from './asset-card';
import { AssetDetail, type AssetDetailProps } from './asset-detail';
import { DetailSheet } from './detail-sheet';
import type { HealthTargets, HomeAsset } from './tab-types';
import { useWideLayout } from './use-wide-layout';

type AssetsTabProps = Omit<AssetDetailProps, 'asset' | 'health' | 'style' | 'className'> & {
  /** Active assets that pass the filters (retired ones are listed apart). */
  assets: HomeAsset[];
  retiredAssets: HomeAsset[];
  /** Every asset in the household, before filters (for the empty state). */
  totalAssets: number;
  health: { targets: HealthTargets };
  selectedAsset: HomeAsset | null;
  setSelectedAssetId: (id: string) => void;
  detailMorph: ReturnType<typeof useInPageMorph>;
  /** A record link asked for this asset (phone: open its sheet). */
  detailRequest: { kind: 'asset' | 'vehicle'; id: string; n: number } | null;
  /** A dialog is open over the page: Back must not close the detail sheet under it. */
  dialogOpen: boolean;
  filtered: boolean;
};

/** Grid classes shared with Vehicles: as many 15rem+ columns as fit (2-3 beside the detail column). */
export const CARD_GRID = 'grid content-start gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))]';
/** The page grid: the cards fill the width; from lg a sticky detail column sits beside them. */
export const PAGE_GRID = 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]';
/** The sticky detail column (below the site header), scrolling on its own when taller than the window. */
export const DETAIL_COLUMN = 'min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain';

/**
 * Home Assets (MA-17, MA-18): the photo-first card grid filling the width, retired assets in a
 * collapsed section below (MA-11j), and the selected asset's detail: a sticky column from `lg`,
 * a full-height sheet on a phone (tapping a card opens it; Back closes it).
 */
export const AssetsTab = React.memo(function AssetsTab(props: AssetsTabProps) {
  const {
    assets, retiredAssets, totalAssets, health, today, selectedAsset, detailMorph, canEdit, setSelectedAssetId, openAssetDialog,
    detailRequest, dialogOpen, filtered,
  } = props;
  const wide = useWideLayout();
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [showRetired, setShowRetired] = React.useState(false);

  // A record link (deep link, Open from a reminder) opens the sheet on a phone.
  // Starts at 0: a link applied as the page first appears (a deep link) opens the sheet too.
  const [handledRequest, setHandledRequest] = React.useState(0);
  if (detailRequest && detailRequest.n !== handledRequest) {
    setHandledRequest(detailRequest.n);
    if (detailRequest.kind === 'asset' && !wide) setSheetOpen(true);
  }

  const select = (asset: HomeAsset, event: React.MouseEvent<HTMLButtonElement>) => {
    if (!wide) {
      setSelectedAssetId(asset.id);
      setSheetOpen(true);
      return;
    }
    if (selectedAsset?.id === asset.id) return;
    const morph = sharedId('asset', asset.id);
    detailMorph.run(morph, () => setSelectedAssetId(asset.id), { sync: true, event });
  };

  const card = (asset: HomeAsset, retired = false) => {
    const morph = sharedId('asset', asset.id);
    const selected = selectedAsset?.id === asset.id;
    return (
      <StaggerItem key={asset.id} className="flex min-w-0" style={wide && !retired ? morphStyle(detailMorph.morphName === morph && !selected ? morph : null) : undefined}>
        <AssetCard
          asset={asset}
          photo={pickAssetPhoto(props.attachments, asset.id)}
          health={health.targets[healthKey('home_asset', asset.id)]}
          warranty={warrantyCountdown(asset, today)}
          selected={selected}
          onSelect={(event) => select(asset, event)}
        />
      </StaggerItem>
    );
  };

  const detail = selectedAsset ? (
    <AssetDetail
      key={selectedAsset.id}
      {...props}
      asset={selectedAsset}
      health={health.targets[healthKey('home_asset', selectedAsset.id)]}
      className={wide ? undefined : 'border-0 shadow-none'}
      style={wide ? morphStyle(detailMorph.morphName === sharedId('asset', selectedAsset.id) ? sharedId('asset', selectedAsset.id) : null) : undefined}
    />
  ) : null;

  return (
    <TabsContent value="assets" className="space-y-4 pt-4">
      {canEdit && totalAssets > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => openAssetDialog()}>
            <Plus className="mr-2 h-4 w-4" />
            Add Home Asset
          </Button>
        </div>
      )}

      {totalAssets === 0 ? (
        <EmptyState
          kind="assets"
          title="No home assets yet"
          description="Add HVAC, appliances, tools and other things you look after to build your registry."
          action={canEdit ? { label: 'Add Home Asset', icon: <Plus className="h-4 w-4" />, onClick: () => openAssetDialog() } : undefined}
        />
      ) : (
        <div className={PAGE_GRID}>
          <div className="min-w-0 space-y-4">
            {assets.length > 0 ? (
              <Stagger className={CARD_GRID}>{assets.map((asset) => card(asset))}</Stagger>
            ) : (
              <EmptyState
                compact
                headingLevel={3}
                title={filtered ? 'No assets match' : 'No active assets'}
                description={filtered ? 'Try another room, category or search.' : 'Retired assets are kept out of the main list.'}
              />
            )}

            {retiredAssets.length > 0 && (
              <div className="rounded-lg border p-3" data-testid="retired-assets">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between px-2"
                  aria-expanded={showRetired}
                  onClick={() => setShowRetired((value) => !value)}
                >
                  <span>Retired ({retiredAssets.length})</span>
                  <span className="text-xs text-muted-foreground">{showRetired ? 'Hide' : 'Show'}</span>
                </Button>
                {showRetired && <Stagger className={`mt-3 ${CARD_GRID}`}>{retiredAssets.map((asset) => card(asset, true))}</Stagger>}
              </div>
            )}
          </div>

          {wide && detail && <div className={DETAIL_COLUMN}>{detail}</div>}
        </div>
      )}

      {!wide && (
        <DetailSheet
          open={sheetOpen && Boolean(selectedAsset)}
          title={selectedAsset?.name ?? 'Home asset'}
          description="Home asset details"
          blocked={dialogOpen}
          onClose={() => setSheetOpen(false)}
          testId="asset-detail-sheet"
        >
          {detail}
        </DetailSheet>
      )}
    </TabsContent>
  );
});
