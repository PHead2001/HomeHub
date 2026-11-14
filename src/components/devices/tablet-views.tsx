'use client';

// What the tablet shows in its main area (docs/modules/devices/README.md, "Tablet
// shell"). Home is the household resting view: the dashboard drawn for the household
// (the house, the household brief with household totals and no greeting by name, the
// tiles of the sections that are on; HP-3b, HP-21, HP-32b, WT-5a). The section views are
// read-only (Shopping, Maintenance and Calendar stay read-only on tablets, JC-24; Chores
// and Pets become actionable with the device actions in F4), built from the same live
// household data, so they show only what the tablet's rules let it read.

import dynamic from 'next/dynamic';
import { useEffect, useState, type ReactNode } from 'react';
import { neededListItems, type TabletShoppingItem } from '@/lib/devices/tablet-shopping';
import { tabletListener } from '@/lib/devices/tablet-listener';
import type { QuerySnapshot } from 'firebase/firestore';
import { Bell, CalendarDays, CheckSquare, PawPrint, ShoppingCart, Wrench } from 'lucide-react';
import { DashboardLoading } from '@/components/dashboard/dashboard-loading';
import { cn } from '@/lib/utils';
import {
  calendarSection,
  choresSection,
  maintenanceSection,
  petsSection,
  shoppingListsSection,
} from '@/lib/devices/tablet-sections';
import { useTablet } from './tablet-context';

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
            {room.chores.map((chore) => <Row key={chore.id} title={chore.task} detail={chore.dueLabel} tone={chore.overdue ? 'warn' : null} />)}
          </ul>
        )
      ) : work.length === 0 ? (
        <p className="text-lg text-muted-foreground">Nothing is due today.</p>
      ) : (
        <ul className="space-y-2">
          {work.map((chore) => (
            <Row key={chore.id} title={chore.task} detail={[chore.room, chore.assignee, chore.dueLabel].filter(Boolean).join(' · ')} tone={chore.overdue ? 'warn' : null} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function PetsView() {
  const { data } = useTablet();
  const pets = petsSection(data.sectionFacts ?? {});
  const status = loadingOr(Boolean(pets), data.failed.has('pets'));
  return (
    <Section title="Pets" icon={PawPrint} testId="tablet-view-pets" empty={status ?? (pets && pets.length === 0 ? 'No pets yet.' : null)}>
      <ul className="space-y-2">
        {pets?.map((pet) => (
          <Row key={pet.id} title={pet.name} detail={`${pet.countLabel} · ${pet.headline}`} tone={pet.fed === false ? 'warn' : pet.fed ? 'ok' : null} testId={`tablet-pet-${pet.id}`} />
        ))}
      </ul>
    </Section>
  );
}

/** One list's needed items, live (the section view shows them all; JC-24 read-only). */
function useListItems(householdId: string, listId: string | undefined) {
  const [state, setState] = useState<{ listId: string; items: TabletShoppingItem[] | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!listId) return;
    let stop: (() => void) | null = null;
    let stopped = false;
    void Promise.all([import('@/lib/firebase'), import('firebase/firestore')]).then(([{ db }, { collection, onSnapshot }]) => {
      if (stopped) return;
      const ref = collection(db, 'households', householdId, 'shopping-lists', listId, 'items');
      stop = tabletListener<QuerySnapshot>(
        (next, error) => onSnapshot(ref, { includeMetadataChanges: true }, next, error),
        {
          confirmed: (snapshot) => !snapshot.metadata.fromCache,
          next: (snapshot) => setState({ listId, items: neededListItems(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))), failed: false }),
          onDenied: () => setState((previous) => ({ listId, items: previous?.listId === listId ? previous.items : null, failed: true })),
        },
      ).stop;
    });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [householdId, listId]);
  return state && state.listId === listId ? state : null;
}

function ShoppingView({ listId }: { listId?: string }) {
  const { data, householdId, navigate } = useTablet();
  const allLists = shoppingListsSection(data.sectionFacts ?? {});
  const status = loadingOr(Boolean(allLists), data.failed.has('shopping'));
  const lists = allLists ?? [];
  const selected = listId ? lists.find((list) => list.id === listId) : undefined;
  const live = useListItems(householdId, listId);
  return (
    <Section title={selected ? selected.name : 'Shopping'} icon={ShoppingCart} testId="tablet-view-shopping" empty={status ?? (lists.length === 0 ? 'No shopping lists yet.' : null)}>
      {listId ? (
        live?.items ? (
          live.items.length === 0 ? <p className="text-lg text-muted-foreground">Nothing needed on this list.</p> : (
            <ul className="space-y-2" data-testid="tablet-shopping-items">
              {live.items.map((item) => <Row key={item.id} title={item.name} detail={item.quantity > 1 ? String(item.quantity) : null} />)}
            </ul>
          )
        ) : (
          <p className="text-lg text-muted-foreground">{live?.failed ? "This list couldn't be loaded right now. It tries again on its own." : 'Loading…'}</p>
        )
      ) : (
        <ul className="space-y-2">
          {lists.map((list) => (
            <li key={list.id}>
              <button
                type="button"
                onClick={() => navigate(`/shopping?list=${encodeURIComponent(list.id)}`)}
                className="flex min-h-14 w-full items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3 text-left"
                data-testid={`tablet-shopping-list-${list.id}`}
              >
                <span className="min-w-0 text-lg font-medium">{list.name}</span>
                <span className="shrink-0 text-sm text-muted-foreground">{list.needed} needed</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">Shopping is read-only on wall tablets. Add or tick items from a phone.</p>
    </Section>
  );
}

function MaintenanceView() {
  const { data } = useTablet();
  const items = maintenanceSection(data.sectionFacts ?? {});
  const status = loadingOr(Boolean(items), data.failed.has('maintenance'));
  return (
    <Section title="Maintenance" icon={Wrench} testId="tablet-view-maintenance" empty={status ?? (items && items.length === 0 ? 'Nothing needs attention.' : null)}>
      <ul className="space-y-2">
        {items?.map((item, index) => <Row key={`${item.label}-${index}`} title={item.label} detail={`${item.statusLabel} · ${item.detail}`} tone={item.overdue ? 'warn' : null} />)}
      </ul>
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
      return <ShoppingView listId={view.listId} />;
    case 'maintenance':
      return <MaintenanceView />;
    case 'calendar':
      return <CalendarView />;
    default:
      return null;
  }
}
