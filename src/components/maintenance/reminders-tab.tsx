'use client';

import * as React from 'react';
import { AlertCircle, CalendarDays, Car, FileText } from 'lucide-react';
import type { MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { SummaryCard } from './page-parts';
import { MILEAGE_DUE_SOON_THRESHOLD, REMINDER_DUE_SOON_DAYS } from './page-model';
import { ReminderList } from './reminder-list';

export type ReminderListShared = Omit<React.ComponentProps<typeof ReminderList>, 'reminders' | 'emptyTitle' | 'emptyDescription'>;

type RemindersTabProps = {
  dueSoonReminders: MaintenanceReminder[];
  overdueReminders: MaintenanceReminder[];
  warrantyReminders: MaintenanceReminder[];
  vehicleServiceReminders: MaintenanceReminder[];
  reminderListProps: ReminderListShared;
  /** Bumped by a successful Undo: the lists start over (see the page). */
  reminderListEpoch: number;
};

/** Reminders: four counts and the four reminder lists with their in-place actions. */
export const RemindersTab = React.memo(function RemindersTab({
  dueSoonReminders, overdueReminders, warrantyReminders, vehicleServiceReminders, reminderListProps, reminderListEpoch,
}: RemindersTabProps) {
  return (
    <TabsContent value="reminders" className="space-y-4 pt-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="Due Soon" value={dueSoonReminders.length} detail={`Within ${REMINDER_DUE_SOON_DAYS} days or ${MILEAGE_DUE_SOON_THRESHOLD} miles`} icon={CalendarDays} />
        <SummaryCard title="Overdue" value={overdueReminders.length} detail="Past due date or mileage" icon={AlertCircle} />
        <SummaryCard title="Warranty Watch" value={warrantyReminders.length} detail="Warranties ending or ended" icon={FileText} />
        <SummaryCard title="Vehicle Service" value={vehicleServiceReminders.length} detail="Service, registration, and inspection" icon={Car} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card data-testid="reminders-due-soon">
          <CardHeader>
            <CardTitle className="font-headline">Due Soon</CardTitle>
            <CardDescription>Maintenance due today or within the default reminder window.</CardDescription>
          </CardHeader>
          <CardContent>
            <ReminderList
              key={reminderListEpoch}
              {...reminderListProps}
              reminders={dueSoonReminders}
              emptyTitle="Nothing due soon"
              emptyDescription="Date and mileage reminders will appear here when they are close."
            />
          </CardContent>
        </Card>

        <Card data-testid="reminders-overdue">
          <CardHeader>
            <CardTitle className="font-headline">Overdue</CardTitle>
            <CardDescription>Items past their date or mileage threshold.</CardDescription>
          </CardHeader>
          <CardContent>
            <ReminderList
              key={reminderListEpoch}
              {...reminderListProps}
              reminders={overdueReminders}
              emptyTitle="Nothing overdue"
              emptyDescription="Overdue scheduled maintenance and vehicle requirements will appear here."
            />
          </CardContent>
        </Card>

        <Card data-testid="reminders-warranty">
          <CardHeader>
            <CardTitle className="font-headline">Warranty Watch</CardTitle>
            <CardDescription>Home asset warranties ending soon or already ended.</CardDescription>
          </CardHeader>
          <CardContent>
            <ReminderList
              key={reminderListEpoch}
              {...reminderListProps}
              reminders={warrantyReminders}
              emptyTitle="No warranty reminders"
              emptyDescription="Warranties ending within the reminder window will appear here."
            />
          </CardContent>
        </Card>

        <Card data-testid="reminders-vehicle">
          <CardHeader>
            <CardTitle className="font-headline">Vehicle Service Due</CardTitle>
            <CardDescription>Vehicle service, registration, and inspection reminders.</CardDescription>
          </CardHeader>
          <CardContent>
            <ReminderList
              key={reminderListEpoch}
              {...reminderListProps}
              reminders={vehicleServiceReminders}
              emptyTitle="No vehicle reminders"
              emptyDescription="Mileage and date-based vehicle reminders will appear here."
            />
          </CardContent>
        </Card>
      </div>
    </TabsContent>
  );
});
