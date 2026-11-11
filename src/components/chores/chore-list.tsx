'use client';

import { useId, useRef } from 'react';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { publicDisplayName, type HouseholdPerson } from '@/lib/member-directory';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { MemberAvatar } from '@/components/member-avatar';
import { addDaysToKey, choreDueKey, completionInstant, dayFromKey, type ChoreRecord } from '@/lib/chores/dates';
import { openSubTasks, type ChoreCapabilities, type ToDoEntry } from '@/lib/chores/list';
import { completerLabel, isDueAfterHouseholdDay } from '@/lib/chores/completion';
import type { MemberColor } from '@/lib/member-colors';
import { SPRING_UI } from '@/lib/motion';
import { inertProps } from '@/lib/inert';
import { cn, stableSlugify } from '@/lib/utils';
import { memberName } from './assignee-select';
import { CompletionCheck } from './completion-check';
import { Stagger, StaggerItem } from '@/components/motion/stagger';

export type ChoreListHandlers = {
  onToggleDone: (chore: ChoreRecord, origin: HTMLElement | null) => void;
  onToggleSelect: (chore: ChoreRecord) => void;
  onSubTaskToggle: (chore: ChoreRecord, subTask: string) => void;
  onReassign: (chore: ChoreRecord, uid: string) => void;
  onDelete: (chore: ChoreRecord) => void;
  onClearMissed: (entry: ToDoEntry) => void;
};

type ChoreListProps = ChoreListHandlers & {
  entries: ToDoEntry[];
  today: string;
  /** Today in the household's timezone: completion opens on the chore's due day there (as on the server). */
  householdToday: string;
  /** The household's timezone, for reading due dates the way the server does. */
  timeZone: string | undefined;
  usersByUid: Map<string, HouseholdPerson>;
  users: HouseholdPerson[];
  colors: Map<string, MemberColor>;
  capabilities: ChoreCapabilities;
  selectMode: boolean;
  selectedIds: ReadonlySet<string>;
  openIds: ReadonlySet<string>;
  onToggleOpen: (id: string) => void;
};

function dueLabel(day: string, today: string): string {
  if (!day) return '';
  if (day === today) return 'Today';
  if (day === addDaysToKey(today, 1)) return 'Tomorrow';
  if (day === addDaysToKey(today, -1)) return 'Yesterday';
  return format(dayFromKey(day), 'EEE, MMM d');
}

function ChoreRow({ entry, props }: { entry: ToDoEntry; props: ChoreListProps }) {
  const { chore, missed } = entry;
  // A row that is leaving (completed, so it moved to Completed) is only a visual
  // echo during its exit slide: hidden from assistive tech and inert, so each
  // chore has exactly one actionable row across To Do, Future and Completed.
  const leaving = !useIsPresent();
  const detailsId = useId();
  const checkRef = useRef<HTMLButtonElement>(null);
  const { capabilities, today } = props;
  const due = choreDueKey(chore);
  const isCompleted = chore.isCompleted;
  const isOverdue = !isCompleted && due !== '' && due < today;
  // Chores can be completed from their due day on, judged in the household's
  // timezone exactly as the server judges it (it refuses earlier ones, CH-2).
  const isFuture = !isCompleted && isDueAfterHouseholdDay(chore, props.householdToday, props.timeZone);
  const hasDetails = Boolean(chore.notes || (chore.subTasks && chore.subTasks.length > 0));
  const isOpen = props.openIds.has(chore.id);
  // `assignedToUid` was resolved when the page loaded (functions/src/shared/assignee.ts).
  const user = chore.assignedToUid ? props.usersByUid.get(chore.assignedToUid) : undefined;
  const name = user ? memberName(user) : publicDisplayName(chore.assignedToDisplayName, 'Unassigned');
  const uid = user?.uid || chore.id;
  const remaining = openSubTasks(chore).length;
  const total = chore.subTasks?.length || 0;
  const completedAt = completionInstant(chore);
  const completedBy = isCompleted ? completerLabel(chore, uid => {
    const completer = props.usersByUid.get(uid);
    return completer ? memberName(completer) : undefined;
  }) : null;

  const avatar = (
    <MemberAvatar uid={uid} name={name} photoUrl={user?.avatarUrl} color={props.colors.get(uid)} size="sm" decorative />
  );

  return (
    <StaggerItem
      as="li"
      layout="position"
      exit={{ opacity: 0, y: 12, transition: { duration: 0.18 } }}
      transition={SPRING_UI}
      className={cn(
        'rounded-lg border bg-card',
        isOverdue && 'border-l-4 border-l-destructive',
        props.selectedIds.has(chore.id) && 'border-primary',
        leaving && 'pointer-events-none',
      )}
      data-chore-id={leaving ? undefined : chore.id}
      aria-hidden={leaving || undefined}
      {...inertProps(leaving)}
    >
      <div className="flex items-start gap-1 p-1 md:gap-2 md:p-1.5">
        {props.selectMode && !isCompleted ? (
          <span className="grid h-[var(--target-min)] w-[var(--target-min)] shrink-0 place-items-center">
            <Checkbox
              checked={props.selectedIds.has(chore.id)}
              onCheckedChange={() => props.onToggleSelect(chore)}
              disabled={isFuture}
              aria-label={`Select ${chore.task}`}
              className="h-5 w-5"
            />
          </span>
        ) : (
          <CompletionCheck
            ref={checkRef}
            checked={isCompleted}
            disabled={!capabilities.canComplete || isFuture}
            label={isCompleted ? `Mark ${chore.task} not done` : `Mark ${chore.task} done`}
            onToggle={() => props.onToggleDone(chore, checkRef.current)}
          />
        )}

        <div className="min-w-0 flex-1 py-1.5">
          {hasDetails ? (
            <button
              type="button"
              className="group flex min-h-[var(--target-min)] w-full items-center gap-1 rounded-sm text-left"
              aria-expanded={isOpen}
              aria-controls={detailsId}
              onClick={() => props.onToggleOpen(chore.id)}
            >
              <span className={cn('line-clamp-2 min-w-0 flex-1 break-words text-sm font-medium md:text-base', isCompleted ? 'text-muted-foreground line-through' : 'text-foreground')}>
                {chore.task}
              </span>
              <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150', isOpen && 'rotate-180')} />
              <span className="sr-only">{isOpen ? 'Hide details' : 'Show details'}</span>
            </button>
          ) : (
            <span className={cn('line-clamp-2 break-words text-sm font-medium md:text-base', isCompleted ? 'text-muted-foreground line-through' : 'text-foreground')}>
              {chore.task}
            </span>
          )}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {isCompleted && completedAt
              ? <span>{completedBy ? `Done by ${completedBy} · ${format(completedAt, 'MMM d')}` : `Done ${format(completedAt, 'MMM d')}`}</span>
              : <span>{dueLabel(due, today)}</span>}
            {isOverdue && <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive">Overdue</span>}
            {total > 0 && !isCompleted && <span>{total - remaining}/{total} steps</span>}
            {missed.length > 0 && (
              <span className="flex items-center gap-1 font-medium text-foreground">
                +{missed.length} earlier missed
                {capabilities.canDelete && (
                  <button
                    type="button"
                    className="inline-flex min-h-[var(--target-min)] min-w-[var(--target-min)] items-center justify-center rounded px-1 font-medium text-primary underline-offset-2 hover:underline"
                    aria-label={`Clear ${missed.length} earlier missed ${chore.task}`}
                    onClick={() => props.onClearMissed(entry)}
                  >
                    Clear
                  </button>
                )}
              </span>
            )}
            <span className="sm:hidden">· {name}</span>
          </span>
        </div>

        {capabilities.canEdit && capabilities.canAssign && !isCompleted ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-[var(--target-min)] min-w-[var(--target-min)] shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent sm:px-2 coarse:text-sm"
                aria-label={`Assigned to ${name}. Reassign ${chore.task}`}
              >
                {avatar}
                <span className="hidden max-w-[8rem] truncate sm:inline">{name}</span>
                <ChevronDown aria-hidden className="hidden h-3 w-3 sm:block" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Assign to</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={chore.assignedToUid || ''} onValueChange={(uid) => props.onReassign(chore, uid)}>
                {props.users.map(member => (
                  <DropdownMenuRadioItem key={member.uid} value={member.uid}>
                    <span className="flex items-center gap-2">
                      <MemberAvatar uid={member.uid} name={memberName(member)} photoUrl={member.avatarUrl} color={props.colors.get(member.uid)} size="sm" decorative />
                      {memberName(member)}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="flex h-[var(--target-min)] shrink-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground sm:px-2 coarse:text-sm">
            {avatar}
            <span className="hidden max-w-[8rem] truncate sm:inline">{name}</span>
            <span className="sr-only sm:hidden">Assigned to {name}</span>
          </span>
        )}

        {capabilities.canDelete && (
          <button
            type="button"
            className="grid h-[var(--target-min)] w-[var(--target-min)] shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
            aria-label={`Delete ${chore.task}`}
            onClick={() => props.onDelete(chore)}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
          </button>
        )}
      </div>

      {hasDetails && isOpen && (
        <div id={detailsId} className="space-y-3 border-t px-4 pb-3 pt-2 md:pl-14">
          {chore.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{chore.notes}</p>}
          {total > 0 && (
            <div className="space-y-0.5">
              <h4 className="text-xs font-semibold text-foreground">Steps</h4>
              {chore.subTasks!.map(subTask => {
                const id = `subtask-${chore.id}-${stableSlugify(subTask)}`;
                return (
                  // Each step is a target-tall row, so the checkboxes' hit areas never overlap (D-2).
                  <div key={subTask} className="flex min-h-[var(--target-min)] items-center gap-3">
                    <Checkbox
                      id={id}
                      checked={(chore.completedSubTasks || []).includes(subTask)}
                      onCheckedChange={() => props.onSubTaskToggle(chore, subTask)}
                      disabled={isCompleted || !capabilities.canComplete}
                    />
                    <Label htmlFor={id} className={cn('text-sm font-normal', isCompleted && 'text-muted-foreground line-through')}>{subTask}</Label>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </StaggerItem>
  );
}

/**
 * Chore rows for one room group. Rows enter with the shared stagger (H12, at most
 * 30 ms apart and 400 ms in all; instant under reduced motion) and completed rows
 * leave with a short slide. Rows are interactive from the first frame.
 */
export function ChoreList(props: ChoreListProps) {
  return (
    <Stagger as="ul" className="space-y-2" count={props.entries.length}>
      <AnimatePresence>
        {props.entries.map(entry => <ChoreRow key={entry.chore.id} entry={entry} props={props} />)}
      </AnimatePresence>
    </Stagger>
  );
}
