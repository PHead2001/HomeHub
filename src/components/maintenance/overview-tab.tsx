'use client';

import * as React from 'react';
import { AlertCircle, Car, ClipboardList, DollarSign, Home, Plus } from 'lucide-react';
import { BrandLogo } from '@/components/brand/brand-logo';
import { PeekCard } from '@/components/dashboard/peek-card';
import { EmptyState } from '@/components/empty-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { healthKey, type HealthDeduction, type HealthResult } from '@/lib/maintenance/health';
import type { computeHomeHealth } from '@/lib/maintenance/health';
import { HealthPanel } from './health-panel';
import { LogList } from './log-list';
import { SummaryCard } from './page-parts';
import type { HomeAsset, LogListShared, MaintenanceLog, OpenTarget, RecentSummary, Vehicle } from './tab-types';

type OverviewTabProps = {
  health: ReturnType<typeof computeHomeHealth>;
  assets: HomeAsset[];
  vehicles: Vehicle[];
  logs: MaintenanceLog[];
  summary: RecentSummary;
  canEdit: boolean;
  logListProps: LogListShared;
  changeTab: (value: string) => void;
  openAssetDialog: () => void;
  openVehicleDialog: () => void;
  openTarget: OpenTarget;
  openHealthDeduction: (deduction: HealthDeduction) => void;
};

/** Overview: health dial, summary counts, the latest logs and the Attention Queue. */
export const OverviewTab = React.memo(function OverviewTab({
  health, assets, vehicles, logs, summary, canEdit, logListProps, changeTab, openAssetDialog, openVehicleDialog, openTarget, openHealthDeduction,
}: OverviewTabProps) {
  const healthFor = (targetType: 'home_asset' | 'vehicle', id: string): HealthResult | undefined => health.targets[healthKey(targetType, id)];
  const flaggedAssets = React.useMemo(() => assets.filter((asset) => asset.status === 'needs_attention'), [assets]);
  const flaggedVehicles = React.useMemo(() => vehicles.filter((vehicle) => vehicle.status === 'needs_attention'), [vehicles]);
  const latestLogs = React.useMemo(() => logs.slice(0, 5), [logs]);

  // Peek cards (H26) for links that leave the current view: key facts at a glance.
  const healthLine = (result?: HealthResult) => (result ? `Health ${result.score}` : null);
  const assetPeek = (asset: HomeAsset) => {
    const facts = [healthLine(healthFor('home_asset', asset.id)), asset.location].filter(Boolean).join(' · ');
    return (
      <div className="space-y-1">
        <p className="font-headline font-semibold">{asset.name}</p>
        <p className="text-muted-foreground">{[asset.brand, asset.model].filter(Boolean).join(' ') || asset.category}</p>
        {facts && <p className="text-xs text-muted-foreground">{facts}</p>}
      </div>
    );
  };
  const vehiclePeek = (vehicle: Vehicle) => {
    const mileage = typeof vehicle.currentMileage === 'number' ? `${vehicle.currentMileage.toLocaleString('en-US')} mi` : null;
    const facts = [healthLine(healthFor('vehicle', vehicle.id)), mileage].filter(Boolean).join(' · ');
    return (
      <div className="space-y-1">
        <p className="font-headline font-semibold">{vehicle.nickname}</p>
        <p className="text-muted-foreground">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</p>
        {facts && <p className="text-xs text-muted-foreground">{facts}</p>}
      </div>
    );
  };

  return (
    <TabsContent value="overview" className="space-y-6 pt-4">
      {health.overall && <HealthPanel health={health.overall} onOpen={openHealthDeduction} />}
      {assets.length === 0 && vehicles.length === 0 && (
        <Card>
          <CardContent className="p-6">
            <EmptyState
              kind="assets"
              title="Start your home registry"
              description="Add the furnace, the fridge or the family car, and HomeHub keeps track of when each needs care."
              action={canEdit ? { label: 'Add home asset', icon: <Plus className="h-4 w-4" />, onClick: () => { changeTab('assets'); openAssetDialog(); } } : undefined}
              secondaryAction={canEdit ? { label: 'Add vehicle', icon: <Car className="h-4 w-4" />, onClick: () => { changeTab('vehicles'); openVehicleDialog(); } } : undefined}
            />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCard title="Home Assets" value={assets.length} detail="Registered household assets" icon={Home} />
        <SummaryCard title="Vehicles" value={vehicles.length} detail="Registered vehicles" icon={Car} />
        <SummaryCard title="Logged, Last 30 Days" value={summary.recentLogs} detail="Logs dated in the last 30 days" icon={ClipboardList} />
        <SummaryCard title="Needs Attention" value={summary.needingAttention} detail="Assets or vehicles flagged" icon={AlertCircle} />
        <SummaryCard title="Spent, Last 30 Days" value={summary.recentCost} format={{ style: 'currency', currency: 'USD' }} detail="Costs on logs from the last 30 days" icon={DollarSign} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="font-headline">Latest Logs</CardTitle>
            <CardDescription>The five most recent entries, whatever their date.</CardDescription>
          </CardHeader>
          <CardContent>
            <LogList {...logListProps} logs={latestLogs} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="font-headline">Attention Queue</CardTitle>
            <CardDescription>Items currently marked as needing attention.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {flaggedAssets.length + flaggedVehicles.length === 0 ? (
              <EmptyState compact headingLevel={3} title="Nothing flagged" description="Mark assets or vehicles as needing attention when they need follow-up." />
            ) : (
              <>
                {flaggedAssets.map(asset => (
                  <PeekCard key={asset.id} peek={assetPeek(asset)}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-ui hover:bg-accent"
                      onClick={() => openTarget({ targetType: 'home_asset', targetId: asset.id, deepLink: `/maintenance?asset=${encodeURIComponent(asset.id)}` })}
                    >
                      <BrandLogo brand={asset.brand} size="sm" className="text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block font-medium">{asset.name}</span>
                        <span className="block text-sm text-muted-foreground">{[asset.category, asset.location].filter(Boolean).join(' · ')}</span>
                      </span>
                    </button>
                  </PeekCard>
                ))}
                {flaggedVehicles.map(vehicle => (
                  <PeekCard key={vehicle.id} peek={vehiclePeek(vehicle)}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-ui hover:bg-accent"
                      onClick={() => openTarget({ targetType: 'vehicle', targetId: vehicle.id, deepLink: `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}` })}
                    >
                      <BrandLogo brand={vehicle.make} size="sm" decorative className="text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block font-medium">{vehicle.nickname}</span>
                        <span className="block text-sm text-muted-foreground">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</span>
                      </span>
                    </button>
                  </PeekCard>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </TabsContent>
  );
});
