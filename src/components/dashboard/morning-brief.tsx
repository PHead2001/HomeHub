'use client';

/**
 * Morning brief (H04): one line from exact dashboard facts, no model call. Its name
 * and greeting follow the household's time of day (HP-22b/c). It types
 * itself out on the first visit of the day (at most ~1.2 s; any key or click skips)
 * and renders instantly afterwards and under reduced motion. Screen readers get
 * the whole sentence at once; every noun phrase is a link once shown, with a peek
 * card (H26). The full sentence reserves its space while typing, so nothing below
 * it moves.
 *
 * The small sparkle button asks AI to rewrite the brief on demand (the overview
 * flow: exact facts computed on the server, the model only words them). The
 * rewrite replaces the line with a quiet "AI-written" marker, HomeHub's exact
 * counts and "Show plain brief"; the plain brief is always the default.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { buildMorningBrief, type BriefPeek } from '@/lib/dashboard/brief';
import { briefLabel, greeting } from '@/lib/dashboard/ambience';
import type { DashboardFacts } from '@/lib/dashboard/facts';
import { briefFacts } from '@/lib/dashboard/dashboard-store';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { BriefAiDetails, useBriefRewrite } from '@/components/home-ai-overview';
import { PeekFacts, PeekLink } from '@/components/ui/peek-link';
import styles from './dashboard.module.css';

const SEEN_KEY = 'homehub.dashboard.briefTyped';
const MAX_TYPE_MS = 1200;
const LINE_CLASS = 'min-h-[3.5rem] font-headline text-lg leading-snug sm:min-h-[2rem] sm:text-xl';

/** "Seen today" uses the household's day (D-6), the same day the facts are counted for. */
const typedToday = (today: string) => {
  try {
    return window.localStorage.getItem(SEEN_KEY) === today;
  } catch {
    return true;
  }
};

/** Peek content for a linked phrase, from the same facts the sentence used. */
function briefPeek(peek: BriefPeek | undefined, facts: DashboardFacts): ReactNode | null {
  if (!peek) return null;
  switch (peek.kind) {
    case 'chores': {
      // HP-11a: "Your chores" lists only the reader's; the household fallback (HP-3a) lists everyone's.
      const mine = peek.scope === 'mine';
      const next = (mine ? facts.chores?.mineNext : facts.chores?.nextUp) ?? [];
      return next.length > 0 ? <PeekFacts title={mine ? 'Your chores' : 'Household chores'} facts={next.map((chore) => [chore.task, chore.dueLabel])} /> : null;
    }
    case 'pet': {
      const pet = facts.pets?.pets.find((candidate) => candidate.id === peek.id);
      return pet ? <PeekFacts title={pet.name} facts={[['Today', pet.countLabel], ['Last meal', pet.headline]]} /> : null;
    }
    case 'pets': {
      const pets = facts.pets?.pets ?? [];
      return pets.length > 0 ? <PeekFacts title="Pets" facts={pets.slice(0, 4).map((pet) => [pet.name, pet.countLabel])} /> : null;
    }
    case 'pantry': {
      const nearest = facts.pantry?.nearest ?? [];
      return nearest.length > 0 ? <PeekFacts title="Expiring soon" facts={nearest.slice(0, 4).map((item) => [item.name, item.label])} /> : null;
    }
    case 'maintenance': {
      const items = facts.maintenance?.items ?? [];
      return items.length > 0 ? <PeekFacts title="Maintenance" facts={items.slice(0, 4).map((item) => [item.label, item.statusLabel])} /> : null;
    }
    case 'shopping': {
      const lists = facts.shopping?.lists ?? [];
      return lists.length > 0 ? <PeekFacts title="Shopping" facts={lists.slice(0, 4).map((list) => [list.name, `${list.needed} needed`])} /> : null;
    }
  }
}

type BriefProps = { facts: DashboardFacts; name?: string | null; now: Date; today: string; timeZone?: string };

function PlainBrief({ facts, name, now, today, timeZone }: BriefProps) {
  const reduced = useReducedMotion();
  // HP-22c: the greeting follows the household's clock, with "Hello" in the small hours.
  const brief = useMemo(() => buildMorningBrief(facts, { greeting: greeting(now, timeZone), name }), [facts, name, now, timeZone]);
  // Mounted on the client once facts are ready, so storage can be read at init. Decided
  // once per mount: the day rolling over while the page is open never retypes it.
  const [typed, setTyped] = useState<number | null>(() => (reduced || typedToday(today) ? null : 0));
  const typing = typed !== null;

  useEffect(() => {
    try {
      window.localStorage.setItem(SEEN_KEY, today);
    } catch {
      // Without storage the brief simply types again next visit.
    }
  }, [today]);

  useEffect(() => {
    if (!typing) return;
    const total = brief.text.length;
    const step = Math.max(1, Math.ceil(total / (MAX_TYPE_MS / 16)));
    let count = 0;
    const finish = () => {
      window.clearInterval(id);
      setTyped(null);
    };
    const id = window.setInterval(() => {
      count += step;
      if (count >= total) finish();
      else setTyped(count);
    }, 16);
    window.addEventListener('keydown', finish, { once: true });
    window.addEventListener('pointerdown', finish, { once: true });
    return () => {
      window.clearInterval(id);
      window.removeEventListener('keydown', finish);
      window.removeEventListener('pointerdown', finish);
    };
    // Types once per mount; later fact changes render instantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typing]);

  return (
    <p className={cn(LINE_CLASS, 'min-w-0 flex-1')} data-testid="morning-brief" data-brief-source="plain">
      {typed !== null && !reduced ? (
        <span className="relative block">
          <span className="sr-only">{brief.text}</span>
          <span aria-hidden className="invisible">{brief.text}</span>
          <span aria-hidden className={cn(styles.caret, 'absolute inset-0')}>{brief.text.slice(0, typed)}</span>
        </span>
      ) : (
        brief.segments.map((segment, index) => segment.href ? (
          <PeekLink
            key={index}
            href={segment.href}
            peek={briefPeek(segment.peek, facts)}
            wrapperClassName="inline"
            // D-2: an inline link in the sentence keeps its look; its hit area is 44 px (48 px on touch).
            className={cn(styles.hitSlop, 'text-primary underline-offset-4 hover:underline')}
          >
            {segment.text}
          </PeekLink>
        ) : (
          <span key={index}>{segment.text}</span>
        ))
      )}
    </p>
  );
}

function BriefLine({ facts, name, now, today, timeZone }: BriefProps) {
  const { currentUser } = useAuth();
  const ai = useBriefRewrite();
  const narrative = ai.result?.narrative ?? null;
  const label = ai.loading ? 'Rewriting the brief with AI' : 'Rewrite the brief with AI';

  return (
    <section aria-label={briefLabel(now, timeZone)} className="mb-6" data-testid="morning-brief-block">
      <div className="flex items-start gap-2">
        {narrative ? (
          <p className={cn(LINE_CLASS, 'min-w-0 flex-1')} data-testid="morning-brief" data-brief-source="ai">
            {narrative.summary}
          </p>
        ) : (
          <PlainBrief facts={facts} name={name} now={now} today={today} timeZone={timeZone} />
        )}
        <button
          type="button"
          onClick={() => void ai.rewrite()}
          disabled={ai.loading || !currentUser?.householdId}
          aria-label={label}
          title={label}
          data-testid="brief-ai-rewrite"
          // D-2: 44 px (48 px on touch), pulled up so the line keeps its rhythm.
          className={cn(styles.target, '-mt-1.5 inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-ui hover:bg-muted hover:text-primary disabled:opacity-60')}
        >
          {ai.loading ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Sparkles aria-hidden className="h-4 w-4" />}
        </button>
      </div>

      {(ai.result || ai.loading) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {narrative && (
            <span className="inline-flex items-center gap-1" data-testid="brief-ai-marker">
              <Sparkles aria-hidden className="h-3 w-3" />
              AI-written from HomeHub&apos;s exact counts
            </span>
          )}
          <button
            type="button"
            onClick={ai.reset}
            className={cn(styles.hitSlop, 'inline-flex items-center gap-1 rounded underline-offset-4 hover:text-foreground hover:underline')}
          >
            <RotateCcw aria-hidden className="h-3 w-3" />
            Show plain brief
          </button>
        </div>
      )}

      <div role="status" aria-live="polite">
        {ai.loading && <p className="mt-1 text-xs text-muted-foreground">Checking your household&apos;s exact facts and asking AI to word them…</p>}
        {ai.error && (
          <p className="mt-1 text-sm text-destructive">
            {ai.error}{' '}
            <button type="button" onClick={() => void ai.rewrite()} className={cn(styles.hitSlop, 'underline underline-offset-4')}>Try again</button>
          </p>
        )}
      </div>

      {ai.result && <BriefAiDetails result={ai.result} />}
    </section>
  );
}

/**
 * Shows a placeholder until the facts are first ready, then stays mounted: a later
 * moment of loading (a new pet's feedings, the day-scoped queries after midnight) keeps
 * the current sentence and the AI rewrite instead of dropping back to the placeholder.
 * The dashboard keys it by the data context, so a household or member change resets it.
 */
export function MorningBrief({ facts, name, now, today, timeZone, ready }: BriefProps & { ready: boolean }) {
  // The last complete facts: while a section is loading again, its absence must never read
  // as "Nothing needs you", so the brief keeps speaking from what was last complete.
  const [held, setHeld] = useState<DashboardFacts | null>(ready ? facts : null);
  if (ready && held !== facts) setHeld(facts);
  const spoken = briefFacts(held, facts, ready);
  if (!spoken) return <div aria-hidden className={cn(LINE_CLASS, 'mb-6 w-3/4 max-w-xl animate-pulse rounded bg-muted')} />;
  return <BriefLine facts={spoken} name={name} now={now} today={today} timeZone={timeZone} />;
}
