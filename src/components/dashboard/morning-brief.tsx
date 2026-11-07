'use client';

/**
 * Morning brief (H04): one line from exact dashboard facts, no model call. It types
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
import { greeting } from '@/lib/dashboard/ambience';
import { dayKey } from '@/lib/dashboard/dates';
import type { DashboardFacts } from '@/lib/dashboard/facts';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { BriefAiDetails, useBriefRewrite } from '@/components/home-ai-overview';
import { PeekFacts, PeekLink } from '@/components/ui/peek-link';
import styles from './dashboard.module.css';

const SEEN_KEY = 'homehub.dashboard.briefTyped';
const MAX_TYPE_MS = 1200;
const LINE_CLASS = 'min-h-[3.5rem] font-headline text-lg leading-snug sm:min-h-[2rem] sm:text-xl';

const typedToday = () => {
  try {
    return window.localStorage.getItem(SEEN_KEY) === dayKey(new Date());
  } catch {
    return true;
  }
};

/** Peek content for a linked phrase, from the same facts the sentence used. */
function briefPeek(peek: BriefPeek | undefined, facts: DashboardFacts): ReactNode | null {
  if (!peek) return null;
  switch (peek.kind) {
    case 'chores': {
      const next = facts.chores?.nextUp ?? [];
      return next.length > 0 ? <PeekFacts title="Your chores" facts={next.map((chore) => [chore.task, chore.dueLabel])} /> : null;
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

function PlainBrief({ facts, name, now }: { facts: DashboardFacts; name?: string | null; now: Date }) {
  const reduced = useReducedMotion();
  const brief = useMemo(() => buildMorningBrief(facts, { greeting: greeting(now), name }), [facts, name, now]);
  // Mounted on the client once facts are ready, so storage can be read at init.
  const [typed, setTyped] = useState<number | null>(() => (reduced || typedToday() ? null : 0));
  const typing = typed !== null;

  useEffect(() => {
    try {
      window.localStorage.setItem(SEEN_KEY, dayKey(new Date()));
    } catch {
      // Without storage the brief simply types again next visit.
    }
  }, []);

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
            className="text-primary underline-offset-4 hover:underline"
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

function BriefLine({ facts, name, now }: { facts: DashboardFacts; name?: string | null; now: Date }) {
  const { currentUser } = useAuth();
  const ai = useBriefRewrite();
  const narrative = ai.result?.narrative ?? null;
  const label = ai.loading ? 'Rewriting the brief with AI' : 'Rewrite the brief with AI';

  return (
    <section aria-label="Morning brief" className="mb-6" data-testid="morning-brief-block">
      <div className="flex items-start gap-2">
        {narrative ? (
          <p className={cn(LINE_CLASS, 'min-w-0 flex-1')} data-testid="morning-brief" data-brief-source="ai">
            {narrative.summary}
          </p>
        ) : (
          <PlainBrief facts={facts} name={name} now={now} />
        )}
        <button
          type="button"
          onClick={() => void ai.rewrite()}
          disabled={ai.loading || !currentUser?.householdId}
          aria-label={label}
          title={label}
          data-testid="brief-ai-rewrite"
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-ui hover:bg-muted hover:text-primary disabled:opacity-60"
        >
          {ai.loading ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Sparkles aria-hidden className="h-4 w-4" />}
        </button>
      </div>

      {ai.result && (
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
            className="inline-flex items-center gap-1 rounded underline-offset-4 hover:text-foreground hover:underline"
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
            <button type="button" onClick={() => void ai.rewrite()} className="underline underline-offset-4">Try again</button>
          </p>
        )}
      </div>

      {ai.result && <BriefAiDetails result={ai.result} />}
    </section>
  );
}

export function MorningBrief({ facts, name, now, ready }: { facts: DashboardFacts; name?: string | null; now: Date; ready: boolean }) {
  if (!ready) return <div aria-hidden className={cn(LINE_CLASS, 'mb-6 w-3/4 max-w-xl animate-pulse rounded bg-muted')} />;
  return <BriefLine facts={facts} name={name} now={now} />;
}
