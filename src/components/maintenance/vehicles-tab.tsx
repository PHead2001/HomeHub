'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
import type { useInPageMorph } from '@/components/shopping/use-in-page-morph';
import { Button } from '@/components/ui/button';
import { TabsContent } from '@/components/ui/tabs';
import { pickVehiclePhoto } from '@/lib/maintenance/display';
import { healthKey } from '@/lib/maintenance/health';
import { morphStyle, sharedId } from '@/lib/motion';
import { CARD_GRID, DETAIL_COLUMN, PAGE_GRID } from './assets-tab';
import { DetailSheet } from './detail-sheet';
import { humanizeLabel } from './page-model';
import type { HealthTargets, Vehicle } from './tab-types';
import { useWideLayout } from './use-wide-layout';
import { VehicleCard } from './vehicle-card';
import { VehicleDetail, type VehicleDetailProps } from './vehicle-detail';

type VehiclesTabProps = Omit<VehicleDetailProps, 'vehicle' | 'health' | 'style' | 'className'> & {
  /** Every vehicle in the household, before filters (for the empty state). */
  totalVehicles: number;
  /** Active vehicles that pass the filters. */
  activeVehicles: Vehicle[];
  inactiveVehicles: Vehicle[];
  health: { targets: HealthTargets };
  selectedVehicle: Vehicle | null;
  showInactiveVehicles: boolean;
  setShowInactiveVehicles: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedVehicleId: (id: string) => void;
  detailMorph: ReturnType<typeof useInPageMorph>;
  detailRequest: { kind: 'asset' | 'vehicle'; id: string; n: number } | null;
  dialogOpen: boolean;
  filtered: boolean;
};

/**
 * Vehicles (MA-17, MA-18): active cards filling the width, sold and retired vehicles in a
 * collapsed section, and the selected vehicle's detail: a sticky column from `lg`, a
 * full-height sheet on a phone (tapping a card opens it; Back closes it).
 */
export const VehiclesTab = React.memo(function VehiclesTab(props: VehiclesTabProps) {
  const {
    totalVehicles, activeVehicles, inactiveVehicles, health, selectedVehicle, detailMorph, showInactiveVehicles, canEdit,
    setShowInactiveVehicles, setSelectedVehicleId, openVehicleDialog, detailRequest, dialogOpen, filtered,
  } = props;
  const wide = useWideLayout();
  const [sheetOpen, setSheetOpen] = React.useState(false);

  // Starts at 0: a link applied as the page first appears (a deep link) opens the sheet too.
  const [handledRequest, setHandledRequest] = React.useState(0);
  if (detailRequest && detailRequest.n !== handledRequest) {
    setHandledRequest(detailRequest.n);
    if (detailRequest.kind === 'vehicle' && !wide) setSheetOpen(true);
  }

  const select = (vehicle: Vehicle, event: React.MouseEvent<HTMLButtonElement>) => {
    if (!wide) {
      setSelectedVehicleId(vehicle.id);
      setSheetOpen(true);
      return;
    }
    if (selectedVehicle?.id === vehicle.id) return;
    detailMorph.run(sharedId('vehicle', vehicle.id), () => setSelectedVehicleId(vehicle.id), { sync: true, event });
  };

  const renderVehicleCard = (vehicle: Vehicle, inactive: boolean) => {
    const morph = sharedId('vehicle', vehicle.id);
    const selected = selectedVehicle?.id === vehicle.id;
    return (
      <VehicleCard
        vehicle={vehicle}
        photo={pickVehiclePhoto(props.attachments, vehicle.id)}
        health={health.targets[healthKey('vehicle', vehicle.id)]}
        selected={selected}
        inactive={inactive}
        statusLabel={inactive ? humanizeLabel(vehicle.status) : undefined}
        style={wide ? morphStyle(detailMorph.morphName === morph && !selected ? morph : null) : undefined}
        onSelect={(event) => select(vehicle, event)}
      />
    );
  };

  const detail = selectedVehicle ? (
    <VehicleDetail
      key={selectedVehicle.id}
      {...props}
      vehicle={selectedVehicle}
      health={health.targets[healthKey('vehicle', selectedVehicle.id)]}
      className={wide ? undefined : 'border-0 shadow-none'}
      style={wide ? morphStyle(detailMorph.morphName === sharedId('vehicle', selectedVehicle.id) ? sharedId('vehicle', selectedVehicle.id) : null) : undefined}
    />
  ) : null;

  return (
    <TabsContent value="vehicles" className="space-y-4 pt-4">
      {canEdit && totalVehicles > 0 && (
        <div className="flex justify-end">
          <Button onClick={() => openVehicleDialog()}>
            <Plus className="mr-2 h-4 w-4" />
            Add Vehicle
          </Button>
        </div>
      )}

      {totalVehicles === 0 ? (
        <EmptyState
          kind="assets"
          title="No vehicles yet"
          description="Add household vehicles to track mileage, key dates and service."
          action={canEdit ? { label: 'Add Vehicle', icon: <Plus className="h-4 w-4" />, onClick: () => openVehicleDialog() } : undefined}
        />
      ) : (
        <div className={PAGE_GRID}>
          <div className="min-w-0 space-y-4">
            {activeVehicles.length > 0 ? (
              <Stagger className={CARD_GRID}>
                {activeVehicles.map((vehicle) => (
                  <StaggerItem key={vehicle.id} className="flex min-w-0">
                    {renderVehicleCard(vehicle, false)}
                  </StaggerItem>
                ))}
              </Stagger>
            ) : (
              <EmptyState
                compact
                headingLevel={3}
                title={filtered ? 'No vehicles match' : 'No active vehicles'}
                description={filtered ? 'Vehicles have no room: clear the room filter, or try another search.' : 'Sold and retired vehicles are kept out of the main vehicle list.'}
              />
            )}

            {inactiveVehicles.length > 0 && (
              <div className="rounded-lg border p-3">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between px-2"
                  aria-expanded={showInactiveVehicles}
                  onClick={() => setShowInactiveVehicles(prev => !prev)}
                >
                  <span>Sold / retired vehicles ({inactiveVehicles.length})</span>
                  <span className="text-xs text-muted-foreground">{showInactiveVehicles ? 'Hide' : 'Show'}</span>
                </Button>
                {showInactiveVehicles && (
                  <div className={`mt-3 ${CARD_GRID}`}>
                    {inactiveVehicles.map((vehicle) => (
                      <div key={vehicle.id} className="flex min-w-0">{renderVehicleCard(vehicle, true)}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {wide && detail && <div className={DETAIL_COLUMN}>{detail}</div>}
        </div>
      )}

      {!wide && (
        <DetailSheet
          open={sheetOpen && Boolean(selectedVehicle)}
          title={selectedVehicle?.nickname ?? 'Vehicle'}
          description="Vehicle details"
          blocked={dialogOpen}
          onClose={() => setSheetOpen(false)}
          testId="vehicle-detail-sheet"
        >
          {detail}
        </DetailSheet>
      )}
    </TabsContent>
  );
});
