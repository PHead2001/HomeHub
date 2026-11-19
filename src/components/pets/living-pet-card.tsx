'use client';

import * as React from 'react';
import { flushSync } from 'react-dom';
import Link from 'next/link';
import { AlertTriangle, Check, ChevronRight, Clock, Edit, HelpCircle, Minus, MoreVertical, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PeekCard } from '@/components/dashboard/peek-card';
import { useMorphNavigation } from '@/hooks/use-morph-navigation';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { feedingHeadline, formatPortion, petHref, petPhotoMorphName, SPECIES_ART_LABEL, speciesArt } from '@/lib/pets/care';
import { boardStatus, type BoardStatus, type BoardTone, type PetsLayout } from '@/lib/pets/board';
import { morphStyle } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { PetProfile } from '@/lib/pets/types';
import { PinnedNoteLine } from './pinned-note-line';
import { PetCareSummary, petAttention, usePetCare, type PetCare } from './pet-care-summary';
import { mealHeadline } from '@/lib/pets/meal-plan';
import { MedicationChips } from './medication-chip';
import { SetMealTimesButton } from './meal-status';
import { PetPhoto } from './pet-photo';
import { HoldToFeedOverlay, useHoldToFeed } from './hold-to-feed';
import { QuickFeedButton, useQuickFeed } from './quick-feed-button';
import { usePointerFine } from './use-pets-layout';

export type PetAttention = NonNullable<ReturnType<typeof petAttention>>;

export type LivingPetCardProps = {
  pet: PetProfile;
  householdId: string;
  canEdit: boolean;
  onEdit: (pet: PetProfile) => void;
  onDelete: (pet: PetProfile) => void;
  priority?: boolean;
  index?: number;
  /** The view this card is drawn in (P4): `grid` (default), the landscape `board` or phone `rows`. */
  layout?: PetsLayout;
  /** On the board: one or two pets get a bigger avatar (PE-9d). */
  roomy?: boolean;
  /**
   * Reports what needs attention on this pet (PE-26: a due or missed meal, an
   * overdue medication), or null; never while its data is loading or failed.
   */
  onAttention?: (petId: string, attention: PetAttention | null) => void;
};

/** Species label for display: the stored type, or the illustration's species for legacy "Other". */
export function petTypeLabel(pet: Pick<PetProfile, 'type' | 'dataAiHint'>): string {
  if (pet.type && pet.type !== 'Other') return pet.type;
  const art = speciesArt(pet.type, pet.dataAiHint);
  return art === 'other' ? 'Pet' : SPECIES_ART_LABEL[art].replace(/^\w/, (c) => c.toUpperCase());
}

/** Peek card facts (H26) for the pet link: what the card does not already show in full. */
function PetPeek({ pet, care }: { pet: PetProfile; care: PetCare }) {
  const { plan, status, dues, now, timeZone } = care;
  return (
    <div className="space-y-1.5" data-testid={`pet-peek-${pet.id}`}>
      <p className="break-words font-semibold text-foreground">{pet.name}</p>
      <p className="text-xs text-muted-foreground">
        {petTypeLabel(pet)} · {formatPortion(plan.amount, plan.unit)}{plan.perDay ? `, ${plan.perDay}× a day` : ''}
      </p>
      {pet.foodSchedule && <p className="line-clamp-2 text-xs text-muted-foreground">{pet.foodSchedule}</p>}
      {care.meal?.kind === 'slots' && <p className="text-xs text-foreground">{mealHeadline(care.meal)}</p>}
      {status && <p className="text-xs text-foreground">{feedingHeadline(status, now, timeZone)}</p>}
      {dues.length > 0 && (
        <ul className="space-y-0.5 text-xs text-foreground">
          {dues.map((due) => <li key={due.medication}>{due.medication}: {due.label}</li>)}
        </ul>
      )}
      <p className="text-xs font-medium text-primary">Open {pet.name}&apos;s page</p>
    </div>
  );
}

/**
 * What every view of a pet card shares: the live care data (from the
 * household's care store, PE-21a), attention reporting (PE-26), the feed
 * controller shared by the Feed button and hold to feed, the hold gesture on the
 * photo, the board status, and the morph navigation to the pet page (H12).
 */
function usePetCardModel({ pet, householdId, onAttention }: Pick<LivingPetCardProps, 'pet' | 'householdId' | 'onAttention'>) {
  const href = petHref(pet.id);
  const care = usePetCare(pet, householdId);
  const attention = care.feedings.loading || care.feedings.error ? null : petAttention(care);
  const attentionKey = attention ? `${attention.meal ?? ''}|${attention.medication ?? ''}` : '';
  React.useEffect(() => {
    if (!onAttention) return;
    onAttention(pet.id, attentionKey ? attention : null);
    // Reported by its text, so a new object for the same state reports nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAttention, pet.id, attentionKey]);
  React.useEffect(() => () => onAttention?.(pet.id, null), [onAttention, pet.id]);
  const reduced = useReducedMotion();
  const { navigate } = useMorphNavigation();
  // The photo takes its shared-element name only while morphing into the pet page
  // (H12), so other View Transitions (the theme reveal) never capture it.
  const [morphing, setMorphing] = React.useState(false);
  React.useEffect(() => {
    if (!morphing) return;
    const timer = window.setTimeout(() => setMorphing(false), 1500);
    return () => window.clearTimeout(timer);
  }, [morphing]);
  const openPet = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Plain navigation under reduced motion and for modified clicks (new tab, etc.);
    // a click swallowed by hold to feed is already prevented.
    if (reduced || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    flushSync(() => setMorphing(true));
    navigate(href);
  };
  const feed = useQuickFeed({ petId: pet.id, petName: pet.name, plan: care.plan, meal: care.meal, status: care.status, food: care.food, known: care.known });
  const photoRef = React.useRef<HTMLDivElement>(null);
  const { hold, enabled: holdEnabled, handlers } = useHoldToFeed(feed, photoRef);
  const board: BoardStatus = boardStatus({
    meal: care.meal,
    status: care.status,
    dues: care.dues,
    feedingsLoading: care.feedings.loading,
    feedingsFailed: Boolean(care.feedings.error),
    medicationFailed: Boolean(care.medications.error),
    now: care.now,
    timeZone: care.timeZone,
  });
  // The photo's ref travels on its own (never inside the model the views read during render).
  return { model: { href, care, attention, morphing, openPet, feed, hold, holdEnabled, handlers, board }, photoRef };
}

type CardModel = ReturnType<typeof usePetCardModel>['model'];
type PhotoRef = React.RefObject<HTMLDivElement>;

/**
 * The photo with hold to feed (H09). On a touch screen it only responds to a
 * hold, a tap never navigates (PE-11a, D-P2); with a mouse a click still opens
 * the pet. Details always have an explicit control (the name, and the chevron
 * on the board and phone rows, PE-11b). `select-none` and `touch-action:
 * manipulation` keep text selection, double-tap zoom and a long-press menu from
 * cancelling a hold (PE-12b), while a vertical pan still scrolls (and cancels it).
 */
function HoldPhoto({ pet, model, photoRef, className, sizes, priority, index, round }: {
  pet: PetProfile;
  model: CardModel;
  photoRef: PhotoRef;
  className: string;
  sizes: string;
  priority?: boolean;
  index?: number;
  round?: boolean;
}) {
  const fine = usePointerFine();
  const photo = (
    <PetPhoto
      name={pet.name}
      type={pet.type}
      hint={pet.dataAiHint}
      photoUrl={pet.photoUrl}
      priority={priority}
      sizes={sizes}
      className={cn('h-full w-full', round && 'rounded-full')}
      blinkOffset={index}
      frameStyle={model.morphing ? morphStyle(petPhotoMorphName(pet.id)) : undefined}
    />
  );
  return (
    <div
      ref={photoRef}
      className={cn('relative shrink-0 select-none [-webkit-touch-callout:none] [touch-action:manipulation]', className)}
      data-testid={`pet-photo-${pet.id}`}
      data-hold-phase={model.hold.phase}
      {...(model.holdEnabled ? model.handlers : {})}
    >
      {fine ? (
        // With a mouse the photo still opens the pet (a duplicate of the name link, so out of the tab order).
        <Link href={model.href} onClick={model.openPet} draggable={false} tabIndex={-1} data-hold-to-feed="" className="block h-full w-full">
          {photo}
        </Link>
      ) : photo}
      {model.holdEnabled && <HoldToFeedOverlay hold={model.hold} feed={model.feed} />}
    </div>
  );
}

function ActionsMenu({ pet, onEdit, onDelete, className }: { pet: PetProfile; onEdit: (pet: PetProfile) => void; onDelete: (pet: PetProfile) => void; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          aria-label={`Open actions for ${pet.name}`}
          data-pet-actions={pet.id}
          className={cn('h-9 w-9 rounded-full bg-background/80 shadow-raised hover:bg-background', className)}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit(pet)}>
          <Edit className="mr-2 h-4 w-4" />
          <span>Edit</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onDelete(pet)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
          <Trash2 className="mr-2 h-4 w-4" />
          <span>Delete</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The pet's name as its explicit details link (PE-11b), with the peek card on
 * hover or focus. The link is a block as wide as the name's column and at least
 * the target height (44 px, 48 px on touch, WT-28), so a short name is still a
 * full-size target; it never overlaps the chevron or the menu beside it. The
 * name inside wraps and clamps at two lines (PE-20d).
 */
function NameLink({ pet, model, className }: { pet: PetProfile; model: CardModel; className?: string }) {
  return (
    <PeekCard peek={<PetPeek pet={pet} care={model.care} />} className="min-w-0 flex-1">
      <h2 className={cn('min-w-0 font-headline font-semibold leading-tight', className)} title={pet.name}>
        <Link
          href={model.href}
          onClick={model.openPet}
          draggable={false}
          className="flex min-h-[var(--target-min)] min-w-[var(--target-min)] items-center rounded-sm [-webkit-touch-callout:none]"
          data-testid={`pet-name-${pet.id}`}
        >
          <span className="line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]">{pet.name}</span>
        </Link>
      </h2>
    </PeekCard>
  );
}

/** A chevron "Details" control: an explicit way to the pet page besides the name (PE-11b). */
function DetailsLink({ pet, model }: { pet: PetProfile; model: CardModel }) {
  return (
    <Button asChild variant="ghost" size="icon" className="h-9 w-9 shrink-0 rounded-full">
      <Link href={model.href} onClick={model.openPet} aria-label={`Details for ${pet.name}`} data-testid={`pet-details-${pet.id}`}>
        <ChevronRight aria-hidden className="h-5 w-5" />
      </Link>
    </Button>
  );
}

const BAND_CLASSES: Record<BoardTone, string> = {
  overdue: 'bg-destructive text-destructive-foreground',
  due: 'bg-warning text-warning-foreground',
  fed: 'bg-success text-success-foreground',
  neutral: 'bg-muted text-foreground',
  unknown: 'bg-muted text-muted-foreground',
};

const BAND_ICONS: Record<BoardTone, typeof Check> = {
  overdue: AlertTriangle,
  due: Clock,
  fed: Check,
  neutral: Minus,
  unknown: HelpCircle,
};

/** The board's full-width status band: colour, an icon and a text label (PE-9b). */
function StatusBand({ status, children }: { status: BoardStatus; children?: React.ReactNode }) {
  const Icon = BAND_ICONS[status.tone];
  return (
    <div className={cn('flex min-h-11 items-center gap-2 px-4 py-1.5 text-base font-semibold', BAND_CLASSES[status.tone])} data-band={status.tone} data-testid="pet-status-band">
      <Icon aria-hidden className="h-5 w-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{status.label}</span>
      {children}
    </div>
  );
}

/** Feed (and Set meal times for a legacy pet), on the board and the phone rows. */
function FeedArea({ pet, model, statusId, hintId, canEdit, onEdit, className, compact }: {
  pet: PetProfile; model: CardModel; statusId: string; hintId: string; canEdit: boolean; onEdit: (pet: PetProfile) => void; className?: string; compact?: boolean;
}) {
  const { care, feed } = model;
  const { meal, status } = care;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {!compact && meal?.kind === 'legacy' && canEdit && <SetMealTimesButton petName={pet.name} onClick={() => onEdit(pet)} />}
      <QuickFeedButton
        petId={pet.id}
        petName={pet.name}
        plan={care.plan}
        meal={meal}
        status={status}
        food={care.food}
        known={care.known}
        controller={feed}
        describedBy={care.feedings.loading ? (model.holdEnabled ? hintId : undefined) : [statusId, model.holdEnabled ? hintId : null].filter(Boolean).join(' ')}
        variant={meal?.kind === 'slots' ? (meal.complete || meal.offDay ? 'secondary' : 'default') : status?.complete ? 'secondary' : 'default'}
        className="w-full"
        compact={compact}
      />
    </div>
  );
}

/** Medication chips on the board and rows: a chip opens Give dose through the pet page's Medication tab. */
function LinkedChips({ pet, care, max = 2 }: { pet: PetProfile; care: PetCare; max?: number }) {
  if (care.medications.error || care.dues.length === 0) return null;
  return (
    <MedicationChips
      dues={care.dues}
      max={max}
      className="self-start"
      hrefFor={(due) => `/pets/${encodeURIComponent(pet.id)}?tab=medication${due.courseId ? `&dose=${encodeURIComponent(due.courseId)}` : ''}`}
    />
  );
}

/**
 * Board card (PE-9): a full-width status band with a text label (green fed,
 * amber meal due, red overdue medication; neutral otherwise, never amber for a
 * pet without confirmed meal times), then the feeding status as the card's
 * biggest text (24 px), an 80 px avatar (160 px when one or two pets share the
 * screen), the name with a details chevron, medication chips, the pinned note
 * and Feed.
 */
function BoardCard({ pet, householdId, canEdit, onEdit, onDelete, priority, index = 0, roomy, model, photoRef }: LivingPetCardProps & { model: CardModel; photoRef: PhotoRef }) {
  const statusId = `pet-status-${pet.id}`;
  const hintId = `feed-hint-${pet.id}`;
  const { attention, board, care } = model;
  return (
    <Card
      className="glow-card relative flex h-full min-h-0 flex-col overflow-hidden select-none [touch-action:manipulation]"
      data-attention={attention ? (attention.medication ? 'medication' : 'meal') : undefined}
      data-testid={`pet-card-${pet.id}`}
      data-layout="board"
    >
      <StatusBand status={board}>
        {canEdit && <ActionsMenu pet={pet} onEdit={onEdit} onDelete={onDelete} className="h-8 w-8 bg-background/90 text-foreground" />}
      </StatusBand>
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
        <HoldPhoto
          pet={pet}
          model={model}
          photoRef={photoRef}
          className={cn('overflow-hidden rounded-xl', roomy ? 'h-40 w-40' : 'h-20 w-20')}
          sizes={roomy ? '160px' : '80px'}
          priority={priority}
          index={index}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-start gap-1">
            <NameLink pet={pet} model={model} className="text-lg" />
            <DetailsLink pet={pet} model={model} />
          </div>
          <div id={statusId} className="min-w-0">
            <p className="break-words text-2xl font-bold leading-tight text-foreground [overflow-wrap:anywhere]" data-testid="pet-status-line">{board.line}</p>
            {board.detail && <p className="mt-0.5 text-sm text-muted-foreground">{board.detail}</p>}
            {/* PE-10b (D-P18): a neutral hint from the parsed schedule, never a "due" claim. */}
            {care.meal?.kind === 'legacy' && care.meal.nextMealHint && <p className="text-sm text-muted-foreground" data-testid="next-meal-hint">{care.meal.nextMealHint}</p>}
            {board.medication && <p className="mt-0.5 text-sm font-medium text-destructive">{board.medication}</p>}
          </div>
          <LinkedChips pet={pet} care={care} />
          <PinnedNoteLine householdId={householdId} petId={pet.id} className="text-sm" />
        </div>
      </div>
      {model.holdEnabled && <span id={hintId} className="sr-only">Or press and hold the photo of {pet.name} to log {model.feed.portion}.</span>}
      <FeedArea pet={pet} model={model} statusId={statusId} hintId={hintId} canEdit={canEdit} onEdit={onEdit} className="relative z-10 mt-auto px-4 pb-4" />
    </Card>
  );
}

/**
 * Phone row card (PE-13a): a 64 px round avatar (hold to feed), the name with a
 * details chevron, the status as a short label and line, and Feed, so several
 * pets fit one screen and the first Feed is above the fold.
 */
function RowCard({ pet, model, photoRef, priority, index = 0 }: LivingPetCardProps & { model: CardModel; photoRef: PhotoRef }) {
  const statusId = `pet-status-${pet.id}`;
  const hintId = `feed-hint-${pet.id}`;
  const { board, attention } = model;
  return (
    <Card
      className={cn('glow-card relative flex items-center gap-3 overflow-hidden p-3 select-none [touch-action:manipulation]', attention && (attention.medication ? 'ring-2 ring-destructive/60' : 'ring-2 ring-warning/80'))}
      data-attention={attention ? (attention.medication ? 'medication' : 'meal') : undefined}
      data-testid={`pet-card-${pet.id}`}
      data-layout="rows"
    >
      <HoldPhoto pet={pet} model={model} photoRef={photoRef} className="h-16 w-16 overflow-hidden rounded-full" sizes="64px" priority={priority} index={index} round />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <NameLink pet={pet} model={model} className="text-base" />
          <DetailsLink pet={pet} model={model} />
        </div>
        <div id={statusId} className="min-w-0">
          <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground" data-testid="pet-status-line">
            <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs', BAND_CLASSES[board.tone])} data-band={board.tone}>{board.label}</span>
            <span className="min-w-0 truncate">{board.line}</span>
          </p>
          {board.medication && <p className="truncate text-xs font-medium text-destructive">{board.medication}</p>}
        </div>
      </div>
      {model.holdEnabled && <span id={hintId} className="sr-only">Or press and hold the photo of {pet.name} to log {model.feed.portion}.</span>}
      <div className="relative z-10 w-24 shrink-0">
        <FeedArea pet={pet} model={model} statusId={statusId} hintId={hintId} canEdit={false} onEdit={() => undefined} compact />
      </div>
    </Card>
  );
}

/**
 * Living pet card (H09). In the default grid: photo with a face-safe crop or
 * species art (D17), the feeding ring, "Fed 2 h ago by Sam", the medication
 * chips, one-tap feeding and hold to feed. The name is an explicit link to the
 * pet page (PE-11b); the card itself is not a link, and on touch the photo only
 * responds to a hold (PE-11a). One feed controller serves the button and the
 * hold, so both go through the shared feed operation (`feedPet`). `layout`
 * draws the same model as a board card or a phone row (P4).
 */
export function LivingPetCard(props: LivingPetCardProps) {
  const { pet, householdId, canEdit, onEdit, onDelete, priority, index = 0, layout = 'grid' } = props;
  const { model, photoRef } = usePetCardModel(props);
  if (layout === 'board') return <BoardCard {...props} model={model} photoRef={photoRef} />;
  if (layout === 'rows') return <RowCard {...props} model={model} photoRef={photoRef} />;
  const { attention, care, feed } = model;
  const hintId = `feed-hint-${pet.id}`;

  return (
    <Card
      // PE-26b: a card that needs attention gets a ring; the order of the cards never changes.
      className={cn(
        'glow-card relative flex h-full flex-col overflow-hidden transition-ui select-none [touch-action:manipulation]',
        attention && (attention.medication ? 'ring-2 ring-destructive/60' : 'ring-2 ring-warning/80'),
      )}
      data-attention={attention ? (attention.medication ? 'medication' : 'meal') : undefined}
      data-testid={`pet-card-${pet.id}`}
      data-layout="grid"
    >
      <HoldPhoto
        pet={pet}
        model={model}
        photoRef={photoRef}
        className="aspect-[4/3] w-full"
        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
        priority={priority}
        index={index}
      />
      {model.holdEnabled && (
        <span id={hintId} className="sr-only">
          Or press and hold the photo of {pet.name} to log {feed.portion}.
        </span>
      )}

      {canEdit && (
        <div className="absolute right-2 top-2 z-20">
          <ActionsMenu pet={pet} onEdit={onEdit} onDelete={onDelete} />
        </div>
      )}

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          {/* Long names without spaces wrap and clamp at two lines instead of being clipped (PE-20d). */}
          <NameLink pet={pet} model={model} className="text-xl" />
          <p className="text-sm text-muted-foreground">{petTypeLabel(pet)}</p>
        </div>
        {/* The most important pinned note as one small line (PE-29c). */}
        <PinnedNoteLine householdId={householdId} petId={pet.id} />

        <PetCareSummary
          pet={pet}
          householdId={householdId}
          care={care}
          feed={feed}
          feedHintId={model.holdEnabled ? hintId : undefined}
          feedClassName="relative z-20 mt-auto pt-1"
          onSetMealTimes={canEdit ? () => onEdit(pet) : undefined}
        />
      </div>
    </Card>
  );
}
