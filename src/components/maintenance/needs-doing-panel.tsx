'use client';

import * as React from 'react';
import { BrandLogo } from '@/components/brand/brand-logo';
import { PeekCard } from '@/components/dashboard/peek-card';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { FilterChip } from '@/lib/maintenance/filters';
import type { FlaggedItem, NeedsDoing } from '@/lib/maintenance/needs-doing';
import { FilterChips } from './filter-chips';
import { ReminderActionsHint, ReminderList } from './reminder-list';
import type { ReminderListShared } from './reminders-tab';
import type { OpenTarget } from './tab-types';

/**
 * The Overview's "Needs doing" list (MA-12, MA-14, MA-26): overdue and due-today work first,
 * then due soon, then snoozed (muted, "Snoozed until …"), each with Done, Log service and
 * Snooze in place; and the items someone flagged "Needs attention", labelled as flags.
 * `room` (the `?location=` chip today, a tablet's room later) narrows it to one room;
 * `needs` is built with `needsDoing(…, roomName)`.
 */
export function NeedsDoingPanel({
  needs,
  room,
  roomChips,
  onRoomChange,
  reminderListProps,
  reminderListEpoch,
  peekFor,
  openTarget,
}: {
  needs: NeedsDoing;
  room: string | null;
  /** Room chips (asset locations); omitted or empty: no chip row. */
  roomChips?: readonly FilterChip[];
  onRoomChange?: (room: string | null) => void;
  reminderListProps: ReminderListShared;
  reminderListEpoch: number;
  /** The peek card's content for a flagged item. */
  peekFor: (item: FlaggedItem) => React.ReactNode;
  openTarget: OpenTarget;
}) {
  const empty = needs.reminders.length === 0 && needs.flagged.length === 0;
  return (
    <Card className="min-w-0" data-testid="needs-doing">
      <CardHeader className="space-y-3">
        <div>
          <CardTitle className="flex items-center gap-2 font-headline">
            Needs doing
            <Badge variant={needs.count > 0 ? 'destructive' : 'secondary'} className="tabular-nums" data-testid="needs-doing-count">{needs.count}</Badge>
          </CardTitle>
          <CardDescription>
            Overdue first, then due today and due soon{room ? ` in ${room}` : ''}. Flagged items are ones someone marked as needing attention.
          </CardDescription>
        </div>
        {roomChips && roomChips.length > 0 && onRoomChange && (
          <FilterChips label="Room" chips={roomChips} selected={room} allLabel="All rooms" onSelect={onRoomChange} />
        )}
        {needs.reminders.length > 0 && <ReminderActionsHint canLog={reminderListProps.canLog} canSnooze={reminderListProps.canSnooze} />}
      </CardHeader>
      <CardContent className="space-y-5">
        {empty && (
          <EmptyState
            compact
            headingLevel={3}
            title="Nothing needs doing"
            description={room ? `Nothing is due in ${room} right now.` : 'Nothing is overdue, due soon or flagged right now.'}
          />
        )}
        {needs.reminders.length > 0 && (
          <ReminderList key={reminderListEpoch} {...reminderListProps} reminders={needs.reminders} emptyTitle="" emptyDescription="" />
        )}
        {needs.flagged.length > 0 && (
          <section aria-labelledby="needs-doing-flagged" className="space-y-2" data-testid="needs-doing-flagged">
            <h3 id="needs-doing-flagged" className="font-headline text-base font-semibold">Flagged: needs attention</h3>
            <ul className="space-y-2">
              {needs.flagged.map((item) => (
                <li key={`${item.targetType}:${item.id}`}>
                  <PeekCard peek={peekFor(item)}>
                    <button
                      type="button"
                      className="flex min-h-[var(--target-min)] w-full items-center gap-3 rounded-lg border p-3 text-left transition-ui hover:bg-accent"
                      onClick={() => openTarget({
                        targetType: item.targetType,
                        targetId: item.id,
                        deepLink: `/maintenance?${item.targetType === 'home_asset' ? 'asset' : 'vehicle'}=${encodeURIComponent(item.id)}`,
                      })}
                    >
                      <BrandLogo brand={item.brand} size="sm" decorative={item.targetType === 'vehicle'} className="text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words font-medium [overflow-wrap:anywhere]">{item.name}</span>
                        <span className="block break-words text-sm text-muted-foreground">{item.detail}</span>
                      </span>
                      <Badge variant="destructive" className="shrink-0">Flagged</Badge>
                    </button>
                  </PeekCard>
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
