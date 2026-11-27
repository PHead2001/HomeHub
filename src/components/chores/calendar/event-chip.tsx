'use client';

import { memo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { format } from 'date-fns';
import { Apple, Check, CalendarX2, HeartPulse, ListChecks, Pill, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { MemberAvatar } from '@/components/member-avatar';
import { PeekCard } from '@/components/dashboard/peek-card';
import { SPRING_SNAPPY } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { MemberColor } from '@/lib/member-colors';
import { dayFromKey, isDayKey } from '@/lib/chores/dates';
import { moveQuickPicks, type CalendarEvent } from '@/lib/chores/calendar';

// One calendar item (H19; audit CA-8 to CA-11, CA-15, CA-19, CA-27): a chip that opens its
// details. Chips are memoised (CA-20): a drag over the grid changes only the drop target's
// `data-drop` attribute, never a chip's props.

const KIND_ICON = { chore: ListChecks, maintenance: Wrench, medication: Pill, care: HeartPulse, pantry: Apple } as const;
const KIND_LABEL = { chore: 'Chore', maintenance: 'Maintenance due', medication: 'Medication given', care: 'Pet care', pantry: 'Pantry expiry' } as const;

/** "Chore", "Maintenance due", "Medication given" (a logged dose) or "Medication due" (an upcoming one). */
export function kindLabel(event: CalendarEvent): string {
  return event.kind === 'medication' && event.medicationDue ? 'Medication due' : KIND_LABEL[event.kind];
}

/** One line of status for the peek and details: overdue, done, planned or the dose countdown. */
export function statusLabel(event: CalendarEvent): string | null {
  if (event.medicationDue) return event.medicationDue.label;
  if (event.overdue) return 'Overdue';
  if (event.completed && event.kind === 'chore') return 'Done';
  if (event.planned) return 'Planned';
  return null;
}

function openLabel(event: CalendarEvent): string {
  if (event.kind === 'chore') return 'Open Chores';
  if (event.kind === 'maintenance') return 'Open Maintenance';
  if (event.kind === 'pantry') return 'Open Pantry';
  return 'Open pet';
}

/** Chip colours by kind and state (the contrast test covers these tokens, CA-19). */
export function chipClasses(event: CalendarEvent, color?: MemberColor) {
  if (event.completed && event.kind === 'chore') return 'bg-muted text-muted-foreground line-through border-l-border';
  if (event.kind === 'maintenance') return cn('bg-info/10 text-info', event.overdue ? 'border-l-destructive' : 'border-l-info');
  if (event.kind === 'pantry') return 'bg-warning/10 text-warning border-l-warning';
  if (event.kind === 'care') return 'bg-success/10 text-success border-l-success';
  if (event.kind === 'medication' && event.medicationDue) {
    // Same colors as the Pets countdown chip: red when overdue, amber when due soon.
    if (event.overdue) return 'bg-destructive/10 text-destructive border-l-destructive border-dashed';
    return cn('bg-warning/10 text-warning border-dashed', event.medicationDue.state === 'upcoming' ? 'border-l-border' : 'border-l-warning');
  }
  if (event.kind === 'medication') return 'bg-success/10 text-success border-l-success';
  return cn(color?.classes.softChip ?? 'bg-primary/10 text-primary', event.overdue ? 'border-l-destructive' : (color?.classes.border ?? 'border-l-primary'));
}

/** The chip's accessible name: kind, title, who, state, and the date where the chip is out of its day (the rail, CA-19). */
export function chipName(event: CalendarEvent, withDate = false): string {
  const parts = [`${kindLabel(event)}: ${event.title}`, event.subtitle];
  if (event.foldedCount) parts.push(`missed ${event.foldedCount} times`);
  if (event.medicationDue) parts.push(event.medicationDue.label.toLowerCase());
  else if (event.overdue) parts.push('overdue');
  if (event.completed && event.kind === 'chore') parts.push('done');
  if (event.planned) parts.push('planned');
  if (withDate) parts.push(`due ${format(dayFromKey(event.day), 'EEEE, MMMM d')}`);
  return parts.join(', ');
}

export type ChipMember = { uid: string; name: string; avatarUrl?: string | null };

export type EventChipProps = {
  event: CalendarEvent;
  color?: MemberColor;
  member?: ChipMember;
  today: string;
  /** Members with `chores.edit`: move. */
  canMove: boolean;
  /** Members with `chores.complete`: Mark done (CA-8). */
  canComplete: boolean;
  /** Members with `chores.delete`: skip one day of a repeating chore (CA-27). */
  canSkip: boolean;
  /** The chore is due after the household's today: Mark done is offered, disabled (CH-2). */
  notDueYet?: boolean;
  /** Name the date in the chip's label (the rail). */
  withDate?: boolean;
  /** False in Month cells: a preview, reached by keyboard in the day's list instead (CA-19). */
  tabbable?: boolean;
  /** Spring the chip into its new day when moved (one copy per event only). */
  animateMove?: boolean;
  /** Fine pointers drag; touch moves from the details (CA-11). */
  draggable: boolean;
  onMove: (event: CalendarEvent, day: string) => void;
  onComplete: (event: CalendarEvent) => void;
  onSkip: (event: CalendarEvent) => void;
  onDragStart: (event: CalendarEvent) => void;
  onDragEnd: () => void;
  /** Tells the page a details panel is open (it never returns to Today under an open panel, CA-12). */
  onOpenChange?: (open: boolean) => void;
};

function EventChipView({
  event, color, member, today, canMove, canComplete, canSkip, notDueYet = false, withDate = false, tabbable = true, animateMove = false, draggable,
  onMove, onComplete, onSkip, onDragStart, onDragEnd, onOpenChange,
}: EventChipProps) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(event.day);
  const [error, setError] = useState('');
  const Icon = KIND_ICON[event.kind];
  const isChore = event.kind === 'chore' && !event.completed;
  // Generated chores move by a write; planned days move through the server (CA-15).
  const movable = canMove && isChore && (Boolean(event.choreId) || Boolean(event.planned && event.templateId && event.roomId && event.occurrenceDay));
  const completable = canComplete && isChore && !event.planned && Boolean(event.choreId);
  const skippable = canSkip && isChore && Boolean(event.templateId && event.occurrenceKey && event.occurrenceDay && event.occurrenceDay >= today);
  const fieldId = `move-${event.id.replace(/[^a-zA-Z0-9-]/g, '-')}`;

  const moveTo = (day: string) => {
    if (!isDayKey(day)) {
      setError('Pick a date.');
      return;
    }
    if (day === event.day) {
      setError('That is already its date.');
      return;
    }
    if (event.planned && day < today) {
      setError('Pick today or a later day.');
      return;
    }
    setOpen(false);
    onOpenChange?.(false);
    onMove(event, day);
  };

  const status = statusLabel(event);
  const when = format(dayFromKey(event.day), 'EEE, MMM d');
  // Peek (H26): the key facts on hover or keyboard focus; the details open on click.
  const peek = (
    <div className="space-y-1" data-testid="calendar-peek">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{kindLabel(event)}</p>
      <p className="font-semibold text-foreground">{event.title}</p>
      <p className="text-xs text-muted-foreground">{event.subtitle} · {when}</p>
      {status && <p className={cn('text-xs font-medium', event.overdue ? 'text-destructive' : 'text-foreground')}>{status}</p>}
      <p className="text-xs font-medium text-primary">{openLabel(event)} from its details</p>
    </div>
  );

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); onOpenChange?.(next); if (next) { setTarget(event.day); setError(''); } }}>
      <PeekCard peek={open ? null : peek} className="min-w-0">
        <motion.div layout={animateMove ? 'position' : false} layoutId={animateMove ? event.id : undefined} transition={SPRING_SNAPPY}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-calendar-chip=""
              tabIndex={tabbable ? undefined : -1}
              draggable={movable && draggable && !event.planned}
              onDragStart={movable && draggable && !event.planned ? (e) => {
                e.dataTransfer.setData('text/plain', event.id);
                e.dataTransfer.effectAllowed = 'move';
                onDragStart(event);
              } : undefined}
              onDragEnd={movable && draggable ? onDragEnd : undefined}
              className={cn(
                'flex min-h-[var(--target-min)] w-full min-w-0 items-center gap-1.5 rounded-md border-l-[3px] px-1.5 py-1 text-left text-sm font-medium leading-tight [@media(pointer:coarse)]:text-[15px]',
                chipClasses(event, color),
                event.planned && 'border-dashed',
                movable && draggable && !event.planned && 'cursor-grab active:cursor-grabbing',
              )}
              aria-label={chipName(event, withDate)}
            >
              {member ? (
                <MemberAvatar uid={member.uid} name={member.name} photoUrl={member.avatarUrl} color={color} size="sm" decorative className="shrink-0" />
              ) : (
                <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="line-clamp-2 min-w-0 break-words">{event.title}</span>
              {event.foldedCount ? <span aria-hidden className="ml-auto shrink-0 rounded-full bg-destructive/10 px-1.5 text-xs font-semibold text-destructive">×{event.foldedCount}</span> : null}
            </button>
          </PopoverTrigger>
        </motion.div>
      </PeekCard>
      <PopoverContent className="w-80" align="start">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{kindLabel(event)}</p>
            <p className="font-semibold text-foreground">{event.title}</p>
            <p className="text-sm text-muted-foreground">{event.subtitle} · {when}</p>
            {event.medicationDue ? (
              <p className={cn('mt-1 text-sm font-medium', event.overdue ? 'text-destructive' : 'text-foreground')}>Next dose: {event.medicationDue.label}</p>
            ) : event.overdue ? <p className="mt-1 text-sm font-medium text-destructive">Overdue{event.foldedCount ? ` (missed ${event.foldedCount} times)` : ''}</p> : null}
            {event.planned && event.kind === 'chore' && <p className="mt-1 text-sm text-muted-foreground">Repeating chore, planned. Moving it adds it to the chart now.</p>}
            {event.planned && event.kind === 'maintenance' && <p className="mt-1 text-sm text-muted-foreground">A later repeat of this schedule, if each one is done on its day.</p>}
          </div>
          {completable && (
            <div className="space-y-1">
              <Button type="button" size="lg" className="h-12 w-full text-base" disabled={notDueYet} onClick={() => { setOpen(false); onOpenChange?.(false); onComplete(event); }}>
                <Check aria-hidden className="mr-2 h-5 w-5" /> Mark done
              </Button>
              {notDueYet && <p className="text-xs text-muted-foreground">Not due yet: it can be completed from {when}.</p>}
            </div>
          )}
          {movable && (
            <form onSubmit={(e) => { e.preventDefault(); moveTo(target); }} className="space-y-2" noValidate>
              <p className="text-sm font-medium text-foreground">Move to</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Move to a day">
                {moveQuickPicks(today, event.day).map(pick => (
                  <Button key={pick.day} type="button" variant="outline" size="sm" className="min-h-[var(--target-min)] px-3" onClick={() => moveTo(pick.day)}>
                    {pick.label}
                  </Button>
                ))}
              </div>
              <Label htmlFor={fieldId}>Move to date</Label>
              <div className="flex gap-2">
                <Input type="date" {...fieldErrorProps(fieldId, error)} value={target} min={event.planned ? today : undefined} onChange={(e) => { setTarget(e.target.value); setError(''); }} />
                <Button type="submit" size="sm" className="min-h-[var(--target-min)]">Move</Button>
              </div>
              <FieldError id={fieldId}>{error}</FieldError>
            </form>
          )}
          {skippable && (
            <Button type="button" variant="outline" className="min-h-[var(--target-min)] w-full" onClick={() => { setOpen(false); onOpenChange?.(false); onSkip(event); }}>
              <CalendarX2 aria-hidden className="mr-2 h-4 w-4" /> Skip this day
            </Button>
          )}
          <Button variant="link" className="h-auto min-h-[var(--target-min)] p-0" asChild>
            <Link href={event.href}>{openLabel(event)}</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const EventChip = memo(EventChipView);
