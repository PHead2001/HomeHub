'use client';

import { CheckCircle2 } from 'lucide-react';
import { MemberAvatar } from '@/components/member-avatar';
import type { MemberColor } from '@/lib/member-colors';
import { RoomIcon } from './room-icons';

export type DoneTodayItem = { id: string; task: string; byUid: string | null; byName: string | null; photoUrl?: string | null };

type RoomHeroProps = {
  name: string;
  icon: string;
  openCount: number;
  doneToday: readonly DoneTodayItem[];
  colors: Map<string, MemberColor>;
};

/**
 * The room layout's header (CH-13): when the page shows one room, the room's name and
 * icon are the first thing on the screen, with what is left and a "Done today" strip
 * of the chores finished there today and who did them.
 */
export function RoomHero({ name, icon, openCount, doneToday, colors }: RoomHeroProps) {
  return (
    <section aria-labelledby="chores-room-title" data-testid="chores-room-hero" className="rounded-xl border bg-card p-4 shadow-raised md:p-5">
      <div className="flex items-center gap-3 md:gap-4">
        <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary md:h-16 md:w-16">
          <RoomIcon name={icon} className="h-7 w-7 md:h-9 md:w-9" />
        </span>
        <div className="min-w-0">
          <h2 id="chores-room-title" className="truncate font-headline text-2xl font-bold tracking-tight md:text-4xl">{name}</h2>
          <p className="text-sm text-muted-foreground md:text-base">
            {openCount === 0 ? 'Nothing left to do here today.' : `${openCount} to do`}
          </p>
        </div>
      </div>
      {doneToday.length > 0 && (
        <div className="mt-3 md:mt-4">
          <h3 className="text-sm font-semibold text-foreground">Done today</h3>
          <ul className="mt-1.5 flex gap-2 overflow-x-auto pb-1" data-testid="chores-done-today">
            {doneToday.map(item => (
              <li key={item.id} className="flex min-h-[var(--target-min)] shrink-0 items-center gap-2 rounded-full border bg-background px-3 text-sm">
                <CheckCircle2 aria-hidden className="h-4 w-4 text-success" />
                <span className="max-w-[12rem] truncate">{item.task}</span>
                {item.byUid && item.byName && (
                  <MemberAvatar uid={item.byUid} name={item.byName} photoUrl={item.photoUrl} color={colors.get(item.byUid)} size="sm" />
                )}
                {!item.byUid && item.byName && <span className="text-muted-foreground">{item.byName}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
