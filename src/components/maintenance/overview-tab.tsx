'use client';

import * as React from 'react';
import { Car, ClipboardList, DollarSign, Home, Plus } from 'lucide-react';
import type { MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { EmptyState } from '@/components/empty-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import type { ComingUp as ComingUpData } from '@/lib/maintenance/coming-up';
import type { FilterChip } from '@/lib/maintenance/filters';
import { healthKey, type HealthDeduction, type HealthResult } from '@/lib/maintenance/health';
import type { computeHomeHealth } from '@/lib/maintenance/health';
import type { FlaggedItem, NeedsDoing } from '@/lib/maintenance/needs-doing';
import { ComingUp } from './coming-up';
import { HealthPanel } from './health-panel';
import { LogList } from './log-list';
import { NeedsDoingPanel } from './needs-doing-panel';
import { SummaryCard } from './page-parts';
import type { ReminderListShared } from './reminders-tab';
import type { HomeAsset, LogListShared, MaintenanceLog, OpenTarget, RecentSummary, Vehicle } from './tab-types';

/** Coming up on the Overview covers the next 30 days; the Reminders tab shows 90 (MA-27a). */
export const OVERVIEW_COMING_UP_DAYS = 30;

type OverviewTabProps = {
  health: ReturnType<typeof computeHomeHealth>;
  assets: HomeAsset[];
  vehicles: Vehicle[];
  /** The five newest logs (sorted, undated last). */
  recentLogs: MaintenanceLog[];
  summary: RecentSummary;
  needs: NeedsDoing;
  room: string | null;
  roomChips: FilterChip[];
  onRoomChange: (room: string | null) => void;
  comingUp: ComingUpData;
  today: string;
  canEdit: boolean;
  logListProps: LogListShared;
  reminderListProps: ReminderListShared;
  reminderListEpoch: number;
  changeTab: (value: string) => void;
  openAssetDialog: () => void;
  openVehicleDialog: () => void;
  openTarget: OpenTarget;
  openReminder: (reminder: MaintenanceReminder) => void;
  openHealthDeduction: (deduction: HealthDeduction) => void;
};

/**
 * Overview (MA-12): "Needs doing" first (overdue, due today, due soon and snoozed reminders
 * with their actions, plus flagged items), beside it home health and the next 30 days; the
 * counts and the recent logs below.
 */
export const OverviewTab = React.memo(function OverviewTab({
  health, assets, vehicles, recentLogs, summary, needs, room, roomChips, onRoomChange, comingUp, today, canEdit, logListProps,
  reminderListProps, reminderListEpoch, changeTab, openAssetDialog, openVehicleDialog, openTarget, openReminder, openHealthDeduction,
}: OverviewTabProps) {
  const healthFor = (targetType: 'home_asset' | 'vehicle', id: string): HealthResult | undefined => health.targets[healthKey(targetType, id)];

  // Peek cards (H26) for flagged items: key facts at a glance.
  const healthLine = (result?: HealthResult) => (result ? `Health ${result.score}` : null);
  const peekFor = (item: FlaggedItem) => {
    if (item.targetType === 'home_asset') {
      const asset = assets.find((entry) => entry.id === item.id);
      const facts = [healthLine(healthFor('home_asset', item.id)), asset?.location].filter(Boolean).join(' · ');
      return (
        <div className="space-y-1">
          <p className="font-headline font-semibold">{item.name}</p>
          <p className="text-muted-foreground">{[asset?.brand, asset?.model].filter(Boolean).join(' ') || asset?.category}</p>
          {facts && <p className="text-xs text-muted-foreground">{facts}</p>}
        </div>
      );
    }
    const vehicle = vehicles.find((entry) => entry.id === item.id);
    const mileage = typeof vehicle?.currentMileage === 'number' ? `${vehicle.currentMileage.toLocaleString('en-US')} mi` : null;
    const facts = [healthLine(healthFor('vehicle', item.id)), mileage].filter(Boolean).join(' · ');
    return (
      <div className="space-y-1">
        <p className="font-headline font-semibold">{item.name}</p>
        <p className="text-muted-foreground">{item.detail}</p>
        {facts && <p className="text-xs text-muted-foreground">{facts}</p>}
      </div>
    );
  };

  // "Add a schedule" when nothing is tracked: the Home Assets tab (and the add form when there is no asset yet).
  const addSchedule = () => {
    changeTab('assets');
    if (assets.length === 0) openAssetDialog();
  };

  return (
    <TabsContent value="overview" className="space-y-6 pt-4">
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <NeedsDoingPanel
          needs={needs}
          room={room}
          roomChips={roomChips}
          onRoomChange={onRoomChange}
          reminderListProps={reminderListProps}
          reminderListEpoch={reminderListEpoch}
          peekFor={peekFor}
          openTarget={openTarget}
        />
        <div className="min-w-0 space-y-4">
          {health.overall && <HealthPanel health={health.overall} onOpen={openHealthDeduction} onAddSchedule={canEdit ? addSchedule : undefined} />}
          <Card data-testid="overview-coming-up">
            <CardHeader>
              <CardTitle className="font-headline">Coming up</CardTitle>
              <CardDescription>The next {OVERVIEW_COMING_UP_DAYS} days. The Reminders tab shows 90.</CardDescription>
            </CardHeader>
            <CardContent>
              <ComingUp data={comingUp} today={today} days={OVERVIEW_COMING_UP_DAYS} onOpen={openReminder} />
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="Home assets" value={assets.length} detail="Registered household assets" icon={Home} />
        <SummaryCard title="Vehicles" value={vehicles.length} detail="Registered vehicles" icon={Car} />
        <SummaryCard title="Logged, last 30 days" value={summary.recentLogs} detail="Logs dated in the last 30 days" icon={ClipboardList} />
        <SummaryCard title="Spent, last 30 days" value={summary.recentCost} format={{ style: 'currency', currency: 'USD' }} detail="Costs on logs from the last 30 days" icon={DollarSign} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-headline">Recent logs</CardTitle>
          <CardDescription>The five newest logs. All of them are on the Logs tab.</CardDescription>
        </CardHeader>
        <CardContent>
          <LogList {...logListProps} logs={recentLogs} />
        </CardContent>
      </Card>
    </TabsContent>
  );
});
