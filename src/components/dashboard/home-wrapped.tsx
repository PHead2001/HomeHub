'use client';

/**
 * Home Wrapped (H23): an on-demand story of the household's year. Loads only when
 * opened, only from sections the member can view, and shows people by first name.
 * Cards change with the arrow buttons, arrow keys or a horizontal swipe. "Share"
 * draws the summary onto a canvas (token colors, first names only) and opens the
 * system share sheet, or saves the image where sharing files is not supported.
 */
import { useRef, useState } from 'react';
import { collection, getCountFromServer, getDocs, query, where } from 'firebase/firestore';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Gift, Loader2, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { DURATION, EASE } from '@/lib/motion';
import { maintenanceSpend, summarizeChores, topPurchasedItem, type WrappedSummary } from '@/lib/dashboard/wrapped';
import type { RawDoc } from '@/lib/dashboard/facts';

type Card = { eyebrow: string; headline: string; detail: string };

const money = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

function buildCards(summary: WrappedSummary, householdName: string): Card[] {
  const cards: Card[] = [{ eyebrow: `${summary.year} at home`, headline: householdName, detail: 'Here is your year, wrapped.' }];
  if (summary.choresDone !== null) {
    cards.push({ eyebrow: 'Chores done', headline: String(summary.choresDone), detail: summary.choresDone === 0 ? 'A quiet year. Plenty of time for next year.' : 'Every one of them ticked off by someone in this house.' });
  }
  if (summary.champion) {
    cards.push({ eyebrow: 'Chore champion', headline: summary.champion.name, detail: `${summary.champion.count} ${summary.champion.count === 1 ? 'chore' : 'chores'} finished.` });
  }
  if (summary.topItem) {
    cards.push({ eyebrow: 'Most ticked off the list', headline: summary.topItem.name, detail: `Bought ${summary.topItem.count} ${summary.topItem.count === 1 ? 'time' : 'times'} (items still on your lists).` });
  }
  if (summary.feedings !== null) {
    cards.push({ eyebrow: 'Pet meals logged', headline: String(summary.feedings), detail: summary.feedings > 0 ? 'Nobody went hungry on your watch.' : 'Log feedings to see them here next time.' });
  }
  if (summary.maintenanceSpend !== null) {
    cards.push({
      eyebrow: 'Spent on upkeep',
      headline: money(summary.maintenanceSpend),
      detail: `Across ${summary.maintenanceLogs ?? 0} maintenance ${summary.maintenanceLogs === 1 ? 'log' : 'logs'}.`,
    });
  }
  cards.push({ eyebrow: 'That was the year', headline: 'Nice work, team.', detail: 'Share it with the household.' });
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
    const year = new Date().getFullYear();
    const base = (...path: string[]) => collection(db, 'households', householdId, ...path);
    const docs = (snapshot: Awaited<ReturnType<typeof getDocs>>) => snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as object) }) as RawDoc);
    try {
      const summary: WrappedSummary = { year, choresDone: null, champion: null, topItem: null, feedings: null, maintenanceSpend: null, maintenanceLogs: null };
      const tasks: Promise<void>[] = [];
      if (permissions['chores.view']) {
        tasks.push(getDocs(query(base('chores'), where('isCompleted', '==', true))).then((snapshot) => {
          Object.assign(summary, summarizeChores(docs(snapshot), year));
        }));
      }
      if (permissions['shopping.view']) {
        tasks.push(getDocs(base('shopping-lists')).then(async (lists) => {
          const items = await Promise.all(lists.docs.map((list) => getDocs(query(base('shopping-lists', list.id, 'items'), where('status', '==', 'purchased')))));
          summary.topItem = topPurchasedItem(items.flatMap(docs));
        }));
      }
      if (permissions['pets.view']) {
        const start = new Date(year, 0, 1);
        tasks.push(getDocs(base('pets')).then(async (pets) => {
          const counts = await Promise.all(pets.docs.map((pet) => getCountFromServer(query(base('pets', pet.id, 'feeding-logs'), where('date', '>=', start)))));
          summary.feedings = counts.reduce((sum, count) => sum + count.data().count, 0);
        }));
      }
      if (permissions['maintenance.view']) {
        tasks.push(getDocs(base('maintenance')).then((snapshot) => {
          const result = maintenanceSpend(docs(snapshot), year);
          summary.maintenanceSpend = result.spend;
          summary.maintenanceLogs = result.logs;
        }));
      }
      await Promise.all(tasks);
      setCards(buildCards(summary, household?.name ?? 'Your home'));
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
      const file = new File([blob], `homehub-wrapped-${new Date().getFullYear()}.png`, { type: 'image/png' });
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
      <Button variant="outline" onClick={openWrapped} data-testid="home-wrapped-open">
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
                <Button variant="ghost" size="icon" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous card">
                  <ChevronLeft aria-hidden />
                </Button>
                <span className="text-xs text-muted-foreground" aria-hidden>{index + 1} / {cards.length}</span>
                {index === cards.length - 1 ? (
                  <Button onClick={share} disabled={sharing}>
                    {sharing ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" /> : <Share2 aria-hidden className="mr-2 h-4 w-4" />}
                    Share
                  </Button>
                ) : (
                  <Button variant="ghost" size="icon" onClick={() => go(1)} aria-label="Next card">
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
