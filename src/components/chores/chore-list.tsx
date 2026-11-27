'use client';

import { memo, useEffect, useId, useMemo, useRef } from 'react';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { ChevronDown, MoreHorizontal, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { assignablePeople, publicDisplayName, type HouseholdPerson } from '@/lib/member-directory';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MemberAvatar } from '@/components/member-avatar';
import { addDaysToKey, choreDueKey, completionInstant, dayFromKey, type ChoreRecord } from '@/lib/chores/dates';
import { openSubTasks, type ChoreCapabilities, type ToDoEntry } from '@/lib/chores/list';
import { completerLabel, isDueAfterHouseholdDay } from '@/lib/chores/completion';
import { focusAfterCompleting, sameRowEntry } from '@/lib/chores/row-focus';
import type { MemberColor } from '@/lib/member-colors';
import { SPRING_UI } from '@/lib/motion';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
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
  /** CH-13: the room view's large cards (bigger name, the assignee's avatar and name always shown). */
  large?: boolean;
};

type RowHandlers = ChoreListHandlers & { onToggleOpen: (id: string) => void };

/** What one row needs. Everything but `entry` is a primitive or a reference the page keeps stable (CH-26). */
type RowProps = {
  entry: ToDoEntry;
  today: string;
  householdToday: string;
  timeZone: string | undefined;
  usersByUid: Map<string, HouseholdPerson>;
  users: HouseholdPerson[];
  colors: Map<string, MemberColor>;
  capabilities: ChoreCapabilities;
  selectMode: boolean;
  selected: boolean;
  open: boolean;
  large: boolean;
  /** Changes only when this list's rows change, so only that group animates its layout (CH-26). */
  layoutKey: string;
  /** Reduced motion (system or in-app): no layout animation at all. */
  reduced: boolean;
  handlers: RowHandlers;
};

function dueLabel(day: string, today: string): string {
  if (!day) return '';
  if (day === today) return 'Today';
  if (day === addDaysToKey(today, 1)) return 'Tomorrow';
  if (day === addDaysToKey(today, -1)) return 'Yesterday';
  return format(dayFromKey(day), 'EEE, MMM d');
}

function ChoreRow(props: RowProps) {
  const { entry, capabilities, today, handlers } = props;
  const { chore, missed } = entry;
  // A row that is leaving (completed, so it moved to Completed) is only a visual
  // echo during its exit slide: hidden from assistive tech and inert, so each
  // chore has exactly one actionable row across To Do, Future and Completed.
  const leaving = !useIsPresent();
  const detailsId = useId();
  const checkRef = useRef<HTMLButtonElement>(null);
  const due = choreDueKey(chore);
  const isCompleted = chore.isCompleted;
  const isOverdue = !isCompleted && due !== '' && due < today;
  // Chores can be completed from their due day on, judged in the household's
  // timezone exactly as the server judges it (it refuses earlier ones, CH-2).
  const isFuture = !isCompleted && isDueAfterHouseholdDay(chore, props.householdToday, props.timeZone);
  const hasDetails = Boolean(chore.notes || (chore.subTasks && chore.subTasks.length > 0));
  const isOpen = props.open;
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

  const large = props.large;
  const avatar = (
    <MemberAvatar uid={uid} name={name} photoUrl={user?.avatarUrl} color={props.colors.get(uid)} size={large ? 'md' : 'sm'} decorative className="shrink-0" />
  );
  const nameSize = large ? 'text-lg md:text-xl' : 'text-sm md:text-base';
  // The room view always shows the assignee's name: on a narrow phone it shrinks (and
  // truncates) before the chore's name does, so the row never overflows.
  const assigneeName = large ? 'min-w-0 max-w-[5rem] truncate text-sm font-medium text-foreground sm:max-w-[10rem] md:text-base' : 'hidden max-w-[8rem] truncate sm:inline';
  const assigneeBox = large ? 'min-w-0 shrink' : 'shrink-0';

  return (
    <StaggerItem
      as="li"
      // CH-26: layout changes are measured only when this group's rows change, and
      // never under reduced motion, so the list is still from its first frame.
      layout={props.reduced ? false : 'position'}
      layoutDependency={props.layoutKey}
      exit={{ opacity: 0, y: 12, transition: { duration: 0.18 } }}
      transition={SPRING_UI}
      className={cn(
        'rounded-lg border bg-card',
        // The calendar's "Open Chores" marks its chore for a moment (CA-17, `?chore=`).
        'transition-shadow data-[highlight=true]:ring-2 data-[highlight=true]:ring-primary',
        large && 'shadow-raised',
        isOverdue && 'border-l-4 border-l-destructive',
        props.selected && 'border-primary',
        leaving && 'pointer-events-none',
      )}
      data-chore-id={leaving ? undefined : chore.id}
      aria-hidden={leaving || undefined}
      {...inertProps(leaving)}
    >
      <div className="flex items-start gap-1 p-1 md:gap-2 md:p-1.5">
        {props.selectMode && !isCompleted ? (
          // CH-16: the whole target-sized cell is the checkbox's label, so a tap anywhere in it selects.
          <label className={cn('grid h-[var(--target-min)] w-[var(--target-min)] shrink-0 place-items-center rounded-md', isFuture ? 'cursor-not-allowed' : 'cursor-pointer')}>
            <Checkbox
              checked={props.selected}
              onCheckedChange={() => handlers.onToggleSelect(chore)}
              disabled={isFuture}
              aria-label={`Select ${chore.task}`}
              className="h-6 w-6"
            />
          </label>
        ) : (
          <CompletionCheck
            ref={checkRef}
            rowCheck
            checked={isCompleted}
            disabled={!capabilities.canComplete || isFuture}
            label={isCompleted ? `Mark ${chore.task} not done` : `Mark ${chore.task} done`}
            onToggle={() => {
              // CH-16: completing moves focus to the next row's check instead of dropping it.
              if (!isCompleted && checkRef.current) focusAfterCompleting(checkRef.current);
              handlers.onToggleDone(chore, checkRef.current);
            }}
          />
        )}

        <div className="min-w-0 flex-1 py-1.5">
          {hasDetails ? (
            <button
              type="button"
              className="group flex min-h-[var(--target-min)] w-full items-center gap-1 rounded-sm text-left"
              aria-expanded={isOpen}
              aria-controls={detailsId}
              onClick={() => handlers.onToggleOpen(chore.id)}
            >
              <span className={cn('line-clamp-2 min-w-0 flex-1 break-words font-medium', nameSize, isCompleted ? 'text-muted-foreground line-through' : 'text-foreground')}>
                {chore.task}
              </span>
              <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150', isOpen && 'rotate-180')} />
              <span className="sr-only">{isOpen ? 'Hide details' : 'Show details'}</span>
            </button>
          ) : (
            <span className={cn('line-clamp-2 break-words font-medium', nameSize, isCompleted ? 'text-muted-foreground line-through' : 'text-foreground')}>
              {chore.task}
            </span>
          )}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground coarse:text-sm">
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
                    onClick={() => handlers.onClearMissed(entry)}
                  >
                    Clear
                  </button>
                )}
              </span>
            )}
            {!large && <span className="sm:hidden">· {name}</span>}
          </span>
        </div>

        {capabilities.canEdit && capabilities.canAssign && !isCompleted ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn('flex h-[var(--target-min)] min-w-[var(--target-min)] items-center justify-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent sm:px-2 coarse:text-sm', assigneeBox)}
                aria-label={`Assigned to ${name}. Reassign ${chore.task}`}
              >
                {avatar}
                <span className={assigneeName}>{name}</span>
                <ChevronDown aria-hidden className="hidden h-3 w-3 sm:block" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Assign to</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={chore.assignedToUid || ''} onValueChange={(uid) => handlers.onReassign(chore, uid)}>
                {assignablePeople(props.users, chore.assignedToUid).map(member => (
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
          <span className={cn('flex h-[var(--target-min)] items-center gap-1.5 px-1.5 text-xs text-muted-foreground sm:px-2 coarse:text-sm', assigneeBox)}>
            {avatar}
            <span className={assigneeName}>{name}</span>
            {!large && <span className="sr-only sm:hidden">Assigned to {name}</span>}
          </span>
        )}

        {capabilities.canDelete && (
          // CH-16: delete sits behind a menu (and still confirms), never beside Done.
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="grid h-[var(--target-min)] w-[var(--target-min)] shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent"
                aria-label={`More actions for ${chore.task}`}
              >
                <MoreHorizontal aria-hidden className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem className="min-h-[var(--target-min)] text-destructive focus:text-destructive" onSelect={() => handlers.onDelete(chore)}>
                <Trash2 aria-hidden className="mr-2 h-4 w-4" /> Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {hasDetails && isOpen && (
        <div id={detailsId} className="space-y-3 border-t px-4 pb-3 pt-2 md:pl-14">
          {chore.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{chore.notes}</p>}
          {total > 0 && (
            <div className="space-y-0.5">
              <h4 className="text-xs font-semibold text-foreground">Steps</h4>
              {chore.subTasks!.map(subTask => (
                <StepRow key={subTask} chore={chore} subTask={subTask} disabled={isCompleted || !capabilities.canComplete} onToggle={handlers.onSubTaskToggle} />
              ))}
            </div>
          )}
        </div>
      )}
    </StaggerItem>
  );
}

/**
 * One step: the whole target-tall row is the checkbox's label (CH-16), so the box is
 * never the only thing to hit, and rows never overlap (D-2).
 */
export function StepRow({ chore, subTask, disabled, onToggle }: { chore: ChoreRecord; subTask: string; disabled: boolean; onToggle: (chore: ChoreRecord, subTask: string) => void }) {
  const id = `subtask-${chore.id}-${stableSlugify(subTask)}`;
  const done = (chore.completedSubTasks || []).includes(subTask);
  return (
    <label htmlFor={id} className={cn('flex min-h-[var(--target-min)] w-full items-center gap-3 rounded-md px-1', disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-accent/50')}>
      <Checkbox id={id} checked={done} onCheckedChange={() => onToggle(chore, subTask)} disabled={disabled} className="h-5 w-5 coarse:h-6 coarse:w-6" />
      <span className={cn('text-sm font-normal coarse:text-base', disabled && done && 'text-muted-foreground line-through')}>{subTask}</span>
    </label>
  );
}

const MemoRow = memo(ChoreRow, (before, after) => {
  const keys = Object.keys(after) as (keyof RowProps)[];
  return keys.every(key => (key === 'entry' ? sameRowEntry(before.entry, after.entry) : before[key] === after[key]));
});

/**
 * Chore rows for one room group. Rows enter with the shared stagger (H12, at most
 * 30 ms apart and 400 ms in all; instant under reduced motion) and completed rows
 * leave with a short slide. Rows are interactive from the first frame.
 *
 * CH-26: rows are memoised; the handlers they get are stable (they read the latest
 * props through a ref), so a tick re-renders only the rows whose chore changed, and a
 * group measures its layout only when its own rows change.
 */
export function ChoreList(props: ChoreListProps) {
  const latest = useRef(props);
  useEffect(() => { latest.current = props; });
  const handlers = useMemo<RowHandlers>(() => ({
    onToggleDone: (chore, origin) => latest.current.onToggleDone(chore, origin),
    onToggleSelect: chore => latest.current.onToggleSelect(chore),
    onSubTaskToggle: (chore, subTask) => latest.current.onSubTaskToggle(chore, subTask),
    onReassign: (chore, uid) => latest.current.onReassign(chore, uid),
    onDelete: chore => latest.current.onDelete(chore),
    onClearMissed: entry => latest.current.onClearMissed(entry),
    onToggleOpen: id => latest.current.onToggleOpen(id),
  }), []);
  const layoutKey = props.entries.map(entry => entry.chore.id).join('|');
  const reduced = useReducedMotion();
  return (
    <Stagger as="ul" className="space-y-2" count={props.entries.length}>
      <AnimatePresence>
        {props.entries.map(entry => (
          <MemoRow
            key={entry.chore.id}
            entry={entry}
            today={props.today}
            householdToday={props.householdToday}
            timeZone={props.timeZone}
            usersByUid={props.usersByUid}
            users={props.users}
            colors={props.colors}
            capabilities={props.capabilities}
            selectMode={props.selectMode}
            selected={props.selectedIds.has(entry.chore.id)}
            open={props.openIds.has(entry.chore.id)}
            large={props.large === true}
            layoutKey={layoutKey}
            reduced={reduced}
            handlers={handlers}
          />
        ))}
      </AnimatePresence>
    </Stagger>
  );
}
