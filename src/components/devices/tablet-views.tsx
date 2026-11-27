'use client';

// What the tablet shows in its main area (docs/modules/devices/README.md, "Tablet
// shell"). Home is the household resting view: the dashboard drawn for the household
// (the house, the household brief with household totals and no greeting by name, the
// tiles of the sections that are on; HP-3b, HP-21, HP-32b, WT-5a). The section views are
// read-only (Calendar stays read-only on tablets) except Chores, whose rows have Done and Take
// (device actions, F4a), Pets, whose rows have Feed (and hold) and Care (F4b-1), Maintenance
// (M8b: tablet-maintenance.tsx, the personal page's Needs doing with Done, Snooze and Log
// service) and Shopping (tablet-shopping.tsx, kitchen mode: tick and quick add, SH-11), built
// from the same live household data, so they show only what the tablet's rules let it read.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Bell, CalendarDays, Check, CheckSquare, Clock, Hand, HeartPulse, PawPrint, UtensilsCrossed } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useFeedAction } from '@/components/pets/use-feed-action';
import { FeedEarlierDialog } from '@/components/pets/feed-earlier-dialog';
import { FeedPressFill, useFeedPress } from '@/components/pets/feed-press';
import type { FeedAction } from '@/components/pets/use-feed-action';
import { usePetLogs } from '@/components/pets/pet-log-api';
import type { PetFeedingLog } from '@/lib/pets/types';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { playFeedback } from '@/lib/feedback';
import { formatPortion } from '@/lib/pets/care';
import type { PetState } from '@/lib/dashboard/facts';
import { DashboardLoading } from '@/components/dashboard/dashboard-loading';
import { cn } from '@/lib/utils';
import {
  calendarSection,
  choresSection,
  petsSection,
} from '@/lib/devices/tablet-sections';
import { useTablet } from './tablet-context';
import { TabletMaintenanceView } from './tablet-maintenance';
import { TabletShoppingView } from './tablet-shopping';
import { TabletMedicationChips, TabletPetSheet, usePetDocument } from './tablet-pet-sheet';
import { useTabletSubmit } from './use-tablet-submit';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useBackCloses } from '@/hooks/use-back-closes';

// Every section view reads the UNCAPPED section facts (`data.sectionFacts`, SECTION_LIMITS)
// through the selectors of src/lib/devices/tablet-sections.ts, a list's own live items, or the
// tablet's own notice listeners; never the dashboard's preview facts. Long lists
// scroll inside the main area (the page itself never scrolls). A unit test reads this file
// and fails if it reads the preview facts.

const Dashboard = dynamic(() => import('@/components/dashboard/dashboard').then((mod) => mod.Dashboard), { ssr: false, loading: () => <DashboardLoading /> });

function Section({ title, icon: Icon, testId, children, empty }: { title: string; icon: typeof Bell; testId: string; children: ReactNode; empty?: string | null }) {
  return (
    <section className="mx-auto max-w-5xl space-y-4 p-6" data-testid={testId} aria-labelledby={`${testId}-title`}>
      <h1 id={`${testId}-title`} className="flex items-center gap-3 font-headline text-3xl font-bold">
        <Icon aria-hidden className="h-7 w-7 text-primary" />
        {title}
      </h1>
      {empty ? <p className="text-lg text-muted-foreground">{empty}</p> : children}
    </section>
  );
}

const Row = ({ title, detail, tone, testId }: { title: string; detail?: string | null; tone?: 'warn' | 'ok' | null; testId?: string }) => (
  <li className="flex min-h-14 items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3" data-testid={testId}>
    <span className="min-w-0 text-lg font-medium">{title}</span>
    {detail && <span className={cn('shrink-0 text-sm', tone === 'warn' ? 'font-semibold text-destructive' : tone === 'ok' ? 'text-primary' : 'text-muted-foreground')}>{detail}</span>}
  </li>
);

const loadingOr = (ready: boolean, failed: boolean): string | null =>
  failed ? "This couldn't be loaded right now. It tries again on its own." : ready ? null : 'Loading…';

/** Done and Take for one chore on the tablet ("Who's here?" first, a PIN when the points-PIN setting asks). */
function ChoreActions({ chore }: { chore: { id: string; task: string; assigneeKey?: string } }) {
  const { runAction } = useTablet();
  const [busy, setBusy] = useState<'complete' | 'take' | null>(null);
  const run = async (kind: 'complete' | 'take') => {
    if (busy) return;
    setBusy(kind);
    try {
      await runAction(kind === 'complete'
        ? { capability: 'chores.complete', label: chore.task, intent: { choreId: chore.id } }
        : { capability: 'chores.take', label: chore.task, intent: { choreId: chore.id } });
    } finally {
      setBusy(null);
    }
  };
  const button = 'inline-flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-lg border border-border px-4 text-base font-medium disabled:opacity-60';
  return (
    <span className="flex shrink-0 gap-2">
      {chore.assigneeKey === '' && (
        <button type="button" className={button} disabled={busy !== null} onClick={() => void run('take')} aria-label={`Take ${chore.task}`} data-testid={`tablet-chore-take-${chore.id}`}>
          <Hand aria-hidden className="h-5 w-5" /> Take
        </button>
      )}
      <button type="button" className={cn(button, 'border-primary/40 text-primary')} disabled={busy !== null} onClick={() => void run('complete')} aria-label={`Mark ${chore.task} done`} data-testid={`tablet-chore-done-${chore.id}`}>
        <Check aria-hidden className="h-5 w-5" /> Done
      </button>
    </span>
  );
}

const ChoreRow = ({ chore, detail }: { chore: { id: string; task: string; overdue: boolean; assigneeKey?: string }; detail: string }) => (
  <li className="flex min-h-14 items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3" data-testid={`tablet-chore-${chore.id}`}>
    <span className="min-w-0">
      <span className="block text-lg font-medium">{chore.task}</span>
      {detail && <span className={cn('block text-sm', chore.overdue ? 'font-semibold text-destructive' : 'text-muted-foreground')}>{detail}</span>}
    </span>
    <ChoreActions chore={chore} />
  </li>
);

function ChoresView({ roomId }: { roomId?: string }) {
  const { data } = useTablet();
  const section = choresSection(data.sectionFacts ?? {}, roomId);
  const failed = data.failed.has('chores');
  const room = section?.kind === 'room' ? section.room : undefined;
  const work = section?.kind === 'today' ? section.work : [];
  const status = loadingOr(Boolean(section), failed);
  return (
    <Section title={room ? `Chores: ${room.name}` : "Today's chores"} icon={CheckSquare} testId="tablet-view-chores" empty={status}>
      {room ? (
        room.chores.length === 0 ? <p className="text-lg text-muted-foreground">Nothing due in {room.name}.</p> : (
          <ul className="space-y-2">
            {room.chores.map((chore) => <ChoreRow key={chore.id} chore={chore} detail={[chore.assignee ?? (chore.assigneeKey ? null : 'Unassigned'), chore.dueLabel].filter(Boolean).join(' · ')} />)}
          </ul>
        )
      ) : work.length === 0 ? (
        <p className="text-lg text-muted-foreground">Nothing is due today.</p>
      ) : (
        <ul className="space-y-2">
          {work.map((chore) => (
            <ChoreRow key={chore.id} chore={chore} detail={[chore.room, chore.assignee ?? (chore.assigneeKey ? null : 'Unassigned'), chore.dueLabel].filter(Boolean).join(' · ')} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * One pet on the tablet: its feeding status, **Feed** (tap: feed now; press and hold: Feed
 * earlier), and **Care**. The pet's picture is only a picture (no gesture). Both are device actions for the person chosen in "Who's here?" (PE-17a/b): the
 * feed goes through the shared feed hook, which on a tablet sends `pets.feed` (the server
 * picks the meal slot and its portion, and asks "Feed again?" when the shared check does);
 * care sends `pets.care.add`. Each offers Undo for 10 s.
 */
function TabletPetRow({ pet, onCare, onOpen }: { pet: PetState; onCare: (pet: PetState) => void; onOpen: (pet: PetState, doseCourseId?: string) => void }) {
  const action = useFeedAction(pet.id, pet.name, { onFed: () => playFeedback('complete') });
  const feed = pet.feed;
  const { run: runFeed } = action;
  const run = useCallback(async () => (feed
    ? runFeed({ portion: { amount: feed.amount, unit: feed.unit }, portionFromSlot: feed.portionFromSlot, food: feed.foodType, known: feed.known })
    : null), [runFeed, feed]);
  const portion = feed ? formatPortion(feed.amount, feed.unit) : '';
  // "When did <pet> eat?": press and hold Feed (500 ms), its clock button, right-click or Shift+Enter.
  const [earlier, setEarlier] = useState(false);
  const { press, handlers: pressHandlers } = useFeedPress({ enabled: action.allowed && Boolean(feed) && !action.saving, onHold: () => setEarlier(true) });
  const button = 'inline-flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-lg border border-border px-4 text-base font-medium disabled:opacity-60';
  return (
    <li className="flex min-h-14 items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3" data-testid={`tablet-pet-${pet.id}`}>
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10" data-testid={`tablet-pet-avatar-${pet.id}`}>
          <PawPrint aria-hidden className="h-7 w-7 text-primary" />
        </span>
        <span className="min-w-0">
          <span className="block text-lg font-medium">{pet.name}</span>
          <span className={cn('block text-sm', pet.fed === false ? 'font-semibold text-destructive' : pet.fed ? 'text-primary' : 'text-muted-foreground')}>
            {[pet.mealLine ?? pet.countLabel, pet.headline].filter(Boolean).join(' · ')}
          </span>
          {action.allowed && <TabletMedicationChips petId={pet.id} onGive={(courseId) => onOpen(pet, courseId)} />}
        </span>
      </span>
      {action.allowed && (
        <span className="flex shrink-0 gap-2">
          <button type="button" className={button} onClick={() => onOpen(pet)} aria-label={`More for ${pet.name}: medication, notes, weight, history, profile`} data-testid={`tablet-pet-more-${pet.id}`}>
            More
          </button>
          <button type="button" className={button} onClick={() => onCare(pet)} aria-label={`Log care for ${pet.name}`} data-testid={`tablet-pet-care-${pet.id}`}>
            <HeartPulse aria-hidden className="h-5 w-5" /> Care
          </button>
          <span className="flex">
            <button
              type="button"
              className={cn(button, 'relative select-none rounded-r-none border-primary/40 text-primary [-webkit-touch-callout:none] [touch-action:manipulation]')}
              disabled={!feed || action.saving}
              onClick={() => void run()}
              aria-label={feed ? `Feed ${pet.name} ${portion}` : `Feed ${pet.name} (feeding status unavailable)`}
              aria-describedby={`tablet-feed-hint-${pet.id}`}
              data-testid={`tablet-pet-feed-${pet.id}`}
              data-press-phase={press.phase}
              {...pressHandlers}
            >
              <UtensilsCrossed aria-hidden className="h-5 w-5" /> Feed
              <FeedPressFill press={press} />
            </button>
            <button
              type="button"
              className={cn(button, 'rounded-l-none border-l-0 border-primary/40 px-3 text-primary')}
              disabled={!feed || action.saving}
              onClick={() => setEarlier(true)}
              aria-label={`Choose feeding time for ${pet.name}`}
              data-testid={`tablet-pet-feed-earlier-${pet.id}`}
            >
              <Clock aria-hidden className="h-5 w-5" />
            </button>
          </span>
          <span id={`tablet-feed-hint-${pet.id}`} className="sr-only">Press and hold Feed, or use the clock button, to log an earlier feeding.</span>
        </span>
      )}
      {earlier && feed && <TabletFeedEarlier pet={pet} action={action} onClose={() => setEarlier(false)} />}
    </li>
  );
}

/**
 * "When did <pet> eat?" on the tablet (owner request "Feed earlier"): the shared dialog, with
 * the pet's meal times and recent feedings read live through the tablet's listener while it
 * is open. Saving goes through the shared feed hook, so it is a device action: `pets.feed`
 * with the chosen time (the server picks `pets.feed.backdated`, or the PIN-level `.old` past
 * 12 hours), "Who's here?" first and Undo after, like Feed.
 */
function TabletFeedEarlier({ pet, action, onClose }: { pet: PetState; action: FeedAction; onClose: () => void }) {
  const { householdId, household } = useTablet();
  const feed = pet.feed;
  // The pet's meal times (its document, through the tablet's listener) and its recent feedings
  // (the shared Pets reader the pet sheet uses, both date shapes).
  const profile = usePetDocument(householdId, pet.id);
  const logs = usePetLogs<PetFeedingLog>(householdId, pet.id, 'feeding-logs', 40);
  // One pending save at a time (the tap guard), one opId across its retries until it is applied.
  const form = useTabletSubmit();
  if (!feed) return null;
  return (
    <FeedEarlierDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      petName={pet.name}
      timeZone={household?.timeZone ?? null}
      pet={profile && !profile.failed && profile.value ? (profile.value as Parameters<typeof FeedEarlierDialog>[0]['pet']) : null}
      logs={logs.loading || logs.error ? null : logs.logs}
      fallbackPortion={{ amount: feed.amount, unit: feed.unit }}
      lastFed={pet.headline}
      saving={action.saving || form.busy}
      onSave={async (choice) => {
        let saved = false;
        await form.submit(async (opId) => {
          const result = await action.run({
            portion: choice.portion,
            // The server logs the portion of the plan in force at the chosen time (never this board's target).
            portionFromSlot: true,
            food: feed.foodType,
            known: feed.known,
            ...(choice.backdatedAt ? { backdatedAt: choice.backdatedAt } : {}),
          }, { opId });
          saved = result !== null;
          return { ok: saved };
        });
        return saved;
      }}
    />
  );
}

/** "Log care" on the tablet: an activity and optional notes, sent as `pets.care.add`. */
function TabletCareDialog({ pet, onClose }: { pet: PetState; onClose: () => void }) {
  const { runAction } = useTablet();
  const [activity, setActivity] = useState('');
  const [notes, setNotes] = useState('');
  // One entry per submit (a ref, not only state, holds a double tap), one opId across retries.
  const form = useTabletSubmit();
  const saving = form.busy;
  useUnsavedInput(activity.trim().length > 0 || notes.trim().length > 0);
  const valid = activity.trim().length >= 3 && activity.trim().length <= 80 && notes.length <= 2000;
  const save = async () => {
    if (!valid) return;
    await form.submit(async (opId) => {
      const outcome = await runAction({ capability: 'pets.care.add', opId, label: `${pet.name}: ${activity.trim()}`, subject: pet.name, intent: { petId: pet.id, activity: activity.trim(), notes: notes.trim() } });
      if (outcome.ok) onClose();
      return outcome;
    });
  };
  // Android Back closes this first (emulator evidence D4).
  useBackCloses(true, onClose);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl" data-testid="tablet-care-dialog">
        <DialogHeader>
          <DialogTitle className="font-headline text-2xl">Log care for {pet.name}</DialogTitle>
          <DialogDescription>A walk, a brushing, a vet visit. It is saved for the person you choose next.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input value={activity} onChange={(event) => setActivity(event.target.value)} placeholder="Walk, brushing" aria-label="Activity" maxLength={80} className="min-h-12 text-lg" data-testid="tablet-care-activity" autoFocus />
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes (optional)" aria-label="Notes" maxLength={2000} className="min-h-24 text-base" data-testid="tablet-care-notes" />
          <div className="flex justify-end gap-2">
            <button type="button" className="min-h-12 rounded-lg border border-border px-4 text-base" onClick={onClose}>Cancel</button>
            <button type="submit" className="min-h-12 rounded-lg bg-primary px-4 text-base font-medium text-primary-foreground disabled:opacity-60" disabled={!valid || saving} data-testid="tablet-care-save">Save</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PetsView() {
  const { data, settings } = useTablet();
  const pets = petsSection(data.sectionFacts ?? {});
  const status = loadingOr(Boolean(pets), data.failed.has('pets'));
  const [caring, setCaring] = useState<PetState | null>(null);
  const [open, setOpen] = useState<{ id: string; name: string; dose?: string | null } | null>(null);
  // A reminder's (or Calendar's) link, `/pets/<id>?tab=medication&dose=<courseId>`: the pet's
  // sheet opens on Medication with Give dose for that course; the link then leaves the address.
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const linkedPet = pathname?.split('/')[2] ? decodeURIComponent(pathname.split('/')[2]) : null;
  const linkedDose = search?.get('dose') ?? null;
  const linkKey = linkedPet ? `${linkedPet}|${linkedDose ?? ''}` : null;
  const [handledLink, setHandledLink] = useState<string | null>(null);
  // Handled once the pets have loaded (state adjusted during render); a link that left the address can open again.
  // The sheet opens only once the link has left the address (D4): its Back entry then sits on
  // top of /pets, so Back closes it instead of returning to the link and opening it again.
  const [pending, setPending] = useState<{ id: string; name: string; dose?: string | null } | null>(null);
  if (linkKey && linkKey !== handledLink && pets) {
    setHandledLink(linkKey);
    const pet = settings.sections.pets ? pets.find((entry) => entry.id === linkedPet) : undefined;
    setPending(pet ? { id: pet.id, name: pet.name, dose: linkedDose } : null);
  } else if (!linkKey && handledLink) {
    setHandledLink(null);
    if (pending) {
      setOpen(pending);
      setPending(null);
    }
  }
  useEffect(() => {
    if (linkKey && handledLink === linkKey) router.replace('/pets');
  }, [handledLink, linkKey, router]);
  return (
    <Section title="Pets" icon={PawPrint} testId="tablet-view-pets" empty={status ?? (pets && pets.length === 0 ? 'No pets yet.' : null)}>
      <ul className="space-y-2">
        {pets?.map((pet) => <TabletPetRow key={pet.id} pet={pet} onCare={setCaring} onOpen={(target, dose) => setOpen({ id: target.id, name: target.name, dose })} />)}
      </ul>
      {caring && <TabletCareDialog pet={caring} onClose={() => setCaring(null)} />}
      {open && <TabletPetSheet petId={open.id} petName={open.name} doseCourseId={open.dose} onClose={() => setOpen(null)} />}
    </Section>
  );
}

/** Calendar has no data of its own: upcoming chores and maintenance from the sections that are on. */
function CalendarView() {
  const { data, settings } = useTablet();
  const { chores, maintenance } = calendarSection(data.sectionFacts ?? {}, settings.sections);
  const empty = chores.length === 0 && maintenance.length === 0 ? 'Nothing coming up.' : null;
  return (
    <Section title="Coming up" icon={CalendarDays} testId="tablet-view-calendar" empty={empty}>
      <ul className="space-y-2">
        {chores.map((chore) => <Row key={`c-${chore.id}`} title={chore.task} detail={[chore.room, chore.dueLabel].filter(Boolean).join(' · ')} tone={chore.overdue ? 'warn' : null} />)}
        {maintenance.map((item, index) => <Row key={`m-${index}`} title={item.label} detail={item.detail} tone={item.overdue ? 'warn' : null} />)}
      </ul>
    </Section>
  );
}

function NoticesView() {
  const { notices, noticesComplete, household } = useTablet();
  const format = (date: Date | null) => (date ? new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: household?.timeZone }).format(date) : '');
  return (
    <Section title="Household notices" icon={Bell} testId="tablet-view-notices" empty={notices.length === 0 ? 'No household notices.' : null}>
      <ul className="space-y-2">
        {notices.map((notice) => (
          <li key={notice.id} className="rounded-xl border border-border bg-card px-4 py-3" data-testid="tablet-notice">
            <p className="flex items-baseline justify-between gap-4">
              <span className="text-lg font-semibold">{notice.title}</span>
              <span className="shrink-0 text-sm text-muted-foreground">{format(notice.createdAt)}</span>
            </p>
            {notice.message && <p className="text-muted-foreground">{notice.message}</p>}
          </li>
        ))}
      </ul>
      {!noticesComplete && <p className="text-sm text-muted-foreground" data-testid="tablet-notices-window">These are the latest household notices; older ones are in HomeHub on a phone.</p>}
    </Section>
  );
}

export function TabletView() {
  const { view } = useTablet();
  if (view.kind === 'home') return <div data-testid="tablet-view-home"><Dashboard /></div>;
  if (view.kind === 'notices') return <NoticesView />;
  switch (view.section) {
    case 'chores':
      return <ChoresView roomId={view.roomId} />;
    case 'pets':
      return <PetsView />;
    case 'shopping':
      return <TabletShoppingView listId={view.listId} />;
    case 'maintenance':
      return <TabletMaintenanceView />;
    case 'calendar':
      return <CalendarView />;
    default:
      return null;
  }
}
