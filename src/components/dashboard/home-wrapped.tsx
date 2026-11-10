'use client';

/**
 * Home Wrapped (H23): an on-demand story of the household's year. Loads only when
 * opened, only from sections the member can view, and shows people by first name.
 * Cards change with the arrow buttons, arrow keys or a horizontal swipe. "Share"
 * draws the summary onto a canvas (token colors, first names only) and opens the
 * system share sheet, or saves the image where sharing files is not supported.
 */
import { useRef, useState } from 'react';
import { Timestamp, collection, doc, getCountFromServer, getDoc, getDocs, query, where } from 'firebase/firestore';
import { choreStatsDocId } from '@functions/shared/chore-stats';
import { isComposingKey } from '@/lib/dashboard/shortcuts';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Gift, Loader2, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { DURATION, EASE } from '@/lib/motion';
import { leaderboardEnabledFrom } from '@/lib/dashboard/streaks';
import { countInYear, maintenanceSpend, readConsistentChoreTotals, summarizeChores, topPurchasedItem, yearBounds, yearIn, type WrappedSummary } from '@/lib/dashboard/wrapped';
import type { RawDoc } from '@/lib/dashboard/facts';
import styles from './dashboard.module.css';

type Card = { eyebrow: string; headline: string; detail: string };

const money = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

function buildCards(summary: WrappedSummary, householdName: string, unavailable: readonly string[] = []): Card[] {
  const cards: Card[] = [{ eyebrow: `${summary.year} at home`, headline: householdName, detail: 'Here is your year, wrapped.' }];
  if (summary.choresDone !== null) {
    cards.push({
      eyebrow: summary.choresWindow === 'last90days' ? 'Chores done (last 90 days)' : `Chores done in ${summary.year}`,
      headline: String(summary.choresDone),
      detail: summary.choresWindow === 'last90days'
        ? summary.choresWindowReason === 'busy'
          ? 'Counts from the last 90 days: yearly totals were being updated while this loaded. Open Wrapped again in a moment for the whole year.'
          : 'Counts from the last 90 days: older completions from before yearly totals were kept are not included.'
        : summary.choresDone === 0 ? 'A quiet year. Plenty of time for next year.' : 'Every one of them ticked off by someone in this house.',
    });
  }
  if (summary.champion) {
    cards.push({
      eyebrow: summary.choresWindow === 'last90days' ? 'Chore champion (last 90 days)' : `Chore champion of ${summary.year}`,
      headline: summary.champion.name,
      detail: `${summary.champion.count} ${summary.champion.count === 1 ? 'chore' : 'chores'} finished.`,
    });
  }
  if (summary.topItem) {
    // Shopping stores no purchase date, so this card is about the lists as they are now, not the year.
    cards.push({
      eyebrow: 'Most bought, on your lists now',
      headline: summary.topItem.name,
      detail: `Ticked off ${summary.topItem.count} ${summary.topItem.count === 1 ? 'time' : 'times'} among bought items still on your lists. Shopping keeps no dated history, so this is not limited to ${summary.year}.`,
    });
  }
  if (summary.feedings !== null) {
    cards.push({ eyebrow: `Pet meals logged in ${summary.year}`, headline: String(summary.feedings), detail: summary.feedings > 0 ? 'Nobody went hungry on your watch.' : 'Log feedings to see them here next time.' });
  }
  if (summary.maintenanceSpend !== null) {
    cards.push({
      eyebrow: `Spent on upkeep in ${summary.year}`,
      headline: money(summary.maintenanceSpend),
      detail: `Across ${summary.maintenanceLogs ?? 0} maintenance ${summary.maintenanceLogs === 1 ? 'log' : 'logs'}.`,
    });
  }
  // A section that could not be read is named here; it is never shown as a zero.
  const missing = unavailable.length > 0 ? `${unavailable.join(', ')} could not be loaded, so ${unavailable.length === 1 ? 'it is' : 'they are'} left out. ` : '';
  cards.push({ eyebrow: 'That was the year', headline: 'Nice work, team.', detail: `${missing}Share it with the household.` });
  return cards;
}

const token = (name: string, alpha = 1) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return value ? `hsl(${value} / ${alpha})` : '';
};

async function renderShareImage(cards: Card[]): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = token('background');
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = token('primary', 0.12);
  context.fillRect(0, 0, canvas.width, 260);
  context.fillStyle = token('primary');
  context.font = '600 44px sans-serif';
  context.fillText('HomeHub Wrapped', 80, 120);
  context.fillStyle = token('foreground');
  context.font = '700 64px sans-serif';
  context.fillText(cards[0].headline.slice(0, 26), 80, 210);
  let y = 360;
  for (const card of cards.slice(1, -1)) {
    context.fillStyle = token('muted-foreground');
    context.font = '500 34px sans-serif';
    context.fillText(card.eyebrow, 80, y);
    context.fillStyle = token('foreground');
    context.font = '700 72px sans-serif';
    context.fillText(card.headline.slice(0, 22), 80, y + 82);
    y += 180;
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function HomeWrapped() {
  const { currentUser, household, permissions } = useAuth();
  const { toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<Card[] | null>(null);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const dragStart = useRef<number | null>(null);
  const householdId = currentUser?.householdId;

  const load = async () => {
    if (!householdId) return;
    setLoading(true);
    setCards(null);
    setIndex(0);
    // The household's current year, not the browser's: around New Year they can differ,
    // and the stats document and every card are bucketed in the household's time zone.
    const year = yearIn(new Date(), household?.timeZone) ?? new Date().getFullYear();
    const base = (...path: string[]) => collection(db, 'households', householdId, ...path);
    const docs = (snapshot: Awaited<ReturnType<typeof getDocs>>) => snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as RawDoc);
    try {
      const summary: WrappedSummary = { year, choresDone: null, champion: null, topItem: null, feedings: null, maintenanceSpend: null, maintenanceLogs: null };
      const tasks: Promise<void>[] = [];
      const unavailable: string[] = [];
      // Each section loads on its own; a failed one is left out and named, never counted as 0.
      const section = (name: string, work: Promise<void>) => tasks.push(work.catch(() => {
        unavailable.push(name);
      }));
      if (permissions['chores.view']) {
        // Member names label the champion; scores are grouped by email (see summarizeChores).
        const members = await getDocs(base('members')).catch(() => null);
        const names = new Map((members?.docs ?? []).flatMap((member) => {
          const data = member.data() as { email?: unknown; displayName?: unknown };
          return typeof data.email === 'string' && typeof data.displayName === 'string' ? [[data.email.trim().toLowerCase(), data.displayName] as const] : [];
        }));
        // Completions upkeep already removed (kept 90 days) live in the yearly stats.
        // Stats and retained chores are read as one consistent snapshot (stats,
        // chores, stats again; retried if a purge lands in between), so no chore is
        // counted twice or missed. A missing or unreadable stats document, or one
        // that keeps changing, falls back to the last 90 days, said on the card.
        const showRanking = await getDoc(doc(db, 'households', householdId, 'chore-settings', 'preferences'))
          .then((snapshot) => leaderboardEnabledFrom(snapshot.exists() ? snapshot.data() : undefined))
          .catch(() => false);
        const statsRef = doc(db, 'households', householdId, 'stats', choreStatsDocId(year));
        section('Chores', readConsistentChoreTotals({
          readStats: () => getDoc(statsRef).then((snapshot) => (snapshot.exists() ? snapshot.data() : undefined)).catch(() => undefined),
          readRetained: () => getDocs(query(base('chores'), where('isCompleted', '==', true))).then(docs),
        }).then((totals) => {
          const stats = totals.consistent ? totals.stats : undefined;
          Object.assign(summary, summarizeChores(totals.retained, year, { names, stats, timeZone: household?.timeZone }));
          // The champion card ranks members, so it follows the Chores "Show leaderboard"
          // setting: shown only when it is known to be on (missing means on, as on Chores).
          if (!showRanking) summary.champion = null;
          if (!stats) summary.choresWindowReason = totals.consistent ? 'no-stats' : 'busy';
        }));
      }
      if (permissions['shopping.view']) {
        section('Shopping', getDocs(base('shopping-lists')).then(async (lists) => {
          const items = await Promise.all(lists.docs.map((list) => getDocs(query(base('shopping-lists', list.id, 'items'), where('status', '==', 'purchased')))));
          summary.topItem = topPurchasedItem(items.flatMap(docs));
        }));
      }
      if (permissions['pets.view']) {
        // Bucketed by each log's own date, in the household's timezone, in both
        // shapes: Timestamps are counted exactly between the zone's year bounds;
        // the (older, few) ISO-string dates are read with a day of margin and
        // counted by their zoned year.
        const { start, end } = yearBounds(year, household?.timeZone);
        section('Pet meals', getDocs(base('pets')).then(async (pets) => {
          const perPet = await Promise.all(pets.docs.map(async (pet) => {
            const logs = base('pets', pet.id, 'feeding-logs');
            const [stamped, strings] = await Promise.all([
              getCountFromServer(query(logs, where('date', '>=', Timestamp.fromDate(start)), where('date', '<', Timestamp.fromDate(end)))),
              getDocs(query(logs, where('date', '>=', `${year - 1}-12-31`), where('date', '<', `${year + 1}-01-02`))),
            ]);
            return stamped.data().count + countInYear(strings.docs.map((entry) => entry.data().date), year, household?.timeZone);
          }));
          summary.feedings = perPet.reduce((sum, count) => sum + count, 0);
        }));
      }
      if (permissions['maintenance.view']) {
        section('Maintenance', getDocs(base('maintenance')).then((snapshot) => {
          const result = maintenanceSpend(docs(snapshot), year, household?.timeZone);
          summary.maintenanceSpend = result.spend;
          summary.maintenanceLogs = result.logs;
        }));
      }
      await Promise.all(tasks);
      setCards(buildCards(summary, household?.name ?? 'Your home', unavailable));
    } catch (error) {
      toastError(error, 'Could not build Home Wrapped');
      setOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const openWrapped = () => {
    setOpen(true);
    void load();
  };

  const go = (delta: number) => {
    if (!cards) return;
    setDirection(delta);
    setIndex((current) => Math.min(cards.length - 1, Math.max(0, current + delta)));
  };

  const share = async () => {
    if (!cards) return;
    setSharing(true);
    try {
      const blob = await renderShareImage(cards);
      if (!blob) throw new Error('canvas-unavailable');
      const file = new File([blob], `homehub-wrapped-${yearIn(new Date(), household?.timeZone) ?? new Date().getFullYear()}.png`, { type: 'image/png' });
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'HomeHub Wrapped' }).catch(() => undefined);
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      toastError(error, 'Could not create the image');
    } finally {
      setSharing(false);
    }
  };

  if (!householdId) return null;
  const card = cards?.[index];

  return (
    <>
      <Button variant="outline" onClick={openWrapped} data-testid="home-wrapped-open" className={styles.target}>
        <Gift aria-hidden className="mr-2 h-4 w-4" />
        Home Wrapped
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md overflow-hidden">
          <DialogHeader>
            <DialogTitle className="font-headline">Home Wrapped</DialogTitle>
            <DialogDescription>Your household&apos;s year so far. Use the arrows or swipe.</DialogDescription>
          </DialogHeader>
          {loading || !card || !cards ? (
            <div role="status" className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Gathering your year...
            </div>
          ) : (
            <div
              className="touch-pan-y select-none"
              onKeyDown={(event) => {
                if (isComposingKey(event)) return;
                if (event.key === 'ArrowRight') go(1);
                if (event.key === 'ArrowLeft') go(-1);
              }}
              onPointerDown={(event) => {
                dragStart.current = event.clientX;
              }}
              onPointerUp={(event) => {
                if (dragStart.current === null) return;
                const delta = event.clientX - dragStart.current;
                dragStart.current = null;
                if (Math.abs(delta) > 50) go(delta < 0 ? 1 : -1);
              }}
            >
              <div className="relative h-64 overflow-hidden rounded-xl border bg-primary/10" aria-live="polite" aria-atomic="true">
                <AnimatePresence initial={false} custom={direction} mode="popLayout">
                  <motion.div
                    key={index}
                    custom={direction}
                    initial={{ opacity: 0, x: direction * 40 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: direction * -40 }}
                    transition={{ duration: DURATION.ui, ease: EASE.standard }}
                    className="absolute inset-0 flex flex-col justify-center gap-2 p-6"
                    data-testid="home-wrapped-card"
                  >
                    <p className="text-sm font-medium text-primary">{card.eyebrow}</p>
                    <p className="break-words font-headline text-4xl font-bold">{card.headline}</p>
                    <p className="text-sm text-muted-foreground">{card.detail}</p>
                  </motion.div>
                </AnimatePresence>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2">
                <Button variant="ghost" size="icon" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous card" className={styles.target}>
                  <ChevronLeft aria-hidden />
                </Button>
                <span className="text-xs text-muted-foreground" aria-hidden>{index + 1} / {cards.length}</span>
                {index === cards.length - 1 ? (
                  <Button onClick={share} disabled={sharing} className={styles.target}>
                    {sharing ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : <Share2 aria-hidden className="mr-2 h-4 w-4" />}
                    Share
                  </Button>
                ) : (
                  <Button variant="ghost" size="icon" onClick={() => go(1)} aria-label="Next card" className={styles.target}>
                    <ChevronRight aria-hidden />
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
