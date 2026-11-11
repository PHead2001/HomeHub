'use client';

/**
 * The command palette's modes (QA-15), opened by the dashboard tile "+" buttons,
 * the N/A/F shortcuts and the phone quick-add fan instead of a typed prefix:
 * - Feeding: the household's pets as large buttons. One tap logs the pet's usual
 *   portion through the shared feed operation (`useFeedAction`: `pets.addLogs`,
 *   "Feed again?", Undo for 10 s), exactly like the dashboard's one-tap Fed. There
 *   is no text field, so a touch screen never raises its keyboard.
 * - Item: the items to add and, with several Grocery lists, a list picker. Enter
 *   saves through the palette's shopping save (Shopping's `addItemsToList` and its
 *   save status).
 * - Chore: what needs doing, read like a typed chore, then the usual preview.
 * Without the permission a mode says why instead of offering a dead control.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { CheckSquare, Loader2, PawPrint, Search, ShoppingCart, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FeedAgainDialog, useFeedAction } from '@/components/pets/use-feed-action';
import { useAuth } from '@/hooks/use-auth';
import { playFeedback } from '@/lib/feedback';
import { DEFAULT_PORTION, formatPortion } from '@/lib/pets/care';
import { cn } from '@/lib/utils';
import {
  MODE_COPY,
  chosenItemList,
  choreModeIntent,
  itemModeIntent,
  type FeedingModeState,
  type ItemModeState,
  type PaletteMode,
} from '@/lib/dashboard/palette-mode';
import type { ChoreIntent, QuickAddContext, QuickAddPet, ShoppingIntent } from '@/lib/dashboard/quick-add';
import { feedingHistory } from './quick-add-actions';

const MODE_ICON: Record<PaletteMode, LucideIcon> = { feeding: PawPrint, item: ShoppingCart, chore: CheckSquare };

const fieldClass = 'h-[var(--target-min)] w-full min-w-0 rounded-md border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring';

function ModeShell({ mode, onTypeInstead, children }: { mode: PaletteMode; onTypeInstead: () => void; children: ReactNode }) {
  const Icon = MODE_ICON[mode];
  return (
    <div className="p-4" data-testid={`palette-mode-${mode}`}>
      <h2 className="flex items-center gap-2 font-headline text-base font-semibold">
        <Icon aria-hidden className="h-5 w-5 text-primary" />
        {MODE_COPY[mode].title}
      </h2>
      <div className="mt-3">{children}</div>
      <div className="mt-4 flex justify-end">
        <Button type="button" variant="ghost" onClick={onTypeInstead} data-testid="palette-mode-type-instead">
          <Search aria-hidden className="mr-2 h-4 w-4" />
          Search or type instead
        </Button>
      </div>
    </div>
  );
}

function Notice({ children, tone = 'muted', onRetry }: { children: ReactNode; tone?: 'muted' | 'error'; onRetry?: () => void }) {
  return (
    <div>
      <p role="status" className={cn('text-sm', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')} data-testid="palette-mode-notice">
        {children}
      </p>
      {onRetry && (
        <Button type="button" variant="outline" className="mt-2" onClick={onRetry} data-testid="palette-mode-retry">
          Try again
        </Button>
      )}
    </div>
  );
}

/** Feeding mode: one large button per pet; no text field. */
export function FeedingMode({
  state,
  onRetry,
  onFed,
  onTypeInstead,
}: {
  state: FeedingModeState;
  onRetry: () => void;
  /** After a feeding is saved or queued (the palette closes; the Undo toast stays). */
  onFed: () => void;
  onTypeInstead: () => void;
}) {
  return (
    <ModeShell mode="feeding" onTypeInstead={onTypeInstead}>
      {state.status === 'ready' ? (
        <ul className="grid max-h-[min(60vh,24rem)] gap-2 overflow-y-auto sm:grid-cols-2" aria-label="Pets">
          {state.pets.map((pet) => (
            <li key={pet.id}>
              <FeedPetButton pet={pet} onFed={onFed} />
            </li>
          ))}
        </ul>
      ) : state.status === 'loading' ? (
        <Notice>Loading your pets…</Notice>
      ) : (
        <Notice tone={state.status === 'failed' ? 'error' : 'muted'} onRetry={state.status === 'failed' ? onRetry : undefined}>{state.message}</Notice>
      )}
    </ModeShell>
  );
}

function FeedPetButton({ pet, onFed }: { pet: QuickAddPet; onFed: () => void }) {
  const { currentUser, household } = useAuth();
  const portion = pet.portion ?? DEFAULT_PORTION;
  const portionText = formatPortion(portion.amount, portion.unit);
  const action = useFeedAction(pet.id, pet.name, {
    onFed: () => {
      playFeedback('complete');
      onFed();
    },
    describe: () => ({ title: `${pet.name} fed`, description: `${portionText} logged.` }),
  });
  const [reading, setReading] = useState(false);
  const busy = reading || action.saving;
  const run = async () => {
    const householdId = currentUser?.householdId;
    if (!householdId || busy) return;
    setReading(true);
    let history: Awaited<ReturnType<typeof feedingHistory>>;
    try {
      // The pet's latest food type and today's count, as the typed quick add reads them.
      history = await feedingHistory(householdId, pet.id, household?.timeZone ?? null);
    } finally {
      setReading(false);
    }
    await action.run({ portion, food: history.food, known: history.known });
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        aria-busy={busy || undefined}
        data-testid={`palette-feed-${pet.id}`}
        className="flex min-h-16 w-full items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-ui hover:border-primary/40 hover:bg-muted disabled:opacity-70"
      >
        {busy
          ? <Loader2 aria-hidden className="h-6 w-6 shrink-0 animate-spin text-muted-foreground" />
          : <PawPrint aria-hidden className="h-6 w-6 shrink-0 text-primary" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium">Feed {pet.name}</span>
          <span className="block truncate text-sm text-muted-foreground">{portionText}</span>
        </span>
      </button>
      <FeedAgainDialog action={action} petName={pet.name} />
    </>
  );
}

/** Item mode: the items, the list (a picker with several Grocery lists), Enter saves. */
export function ItemMode({
  state,
  text,
  onText,
  listId,
  onListId: setListId,
  onRetry,
  onSave,
  onOpenShopping,
  onTypeInstead,
}: {
  state: ItemModeState;
  text: string;
  onText: (text: string) => void;
  /** The list the member picked (kept by the palette across the preview), or null for the preselected one. */
  listId: string | null;
  onListId: (listId: string) => void;
  onRetry: () => void;
  onSave: (intent: ShoppingIntent) => void;
  onOpenShopping: () => void;
  onTypeInstead: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const choices = state.status === 'ready' ? state.choices : [];
  const list = chosenItemList(choices, listId, state.status === 'ready' ? state.initial : null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const intent = itemModeIntent(text, list);
    if (!intent) {
      setError('Type what to add, like “milk, 2 eggs”.');
      return;
    }
    onSave(intent);
  };
  return (
    <ModeShell mode="item" onTypeInstead={onTypeInstead}>
      {state.status === 'ready' ? (
        <form onSubmit={submit} noValidate>
          <label htmlFor="palette-item-text" className="mb-1 block text-sm text-muted-foreground">Items</label>
          <div className="flex gap-2">
            <input
              id="palette-item-text"
              // Typing is the point of this mode, so the field takes focus.
              autoFocus
              value={text}
              onChange={(event) => {
                onText(event.target.value);
                setError(null);
              }}
              enterKeyHint="done"
              autoComplete="off"
              placeholder="milk, 2 eggs"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'palette-item-error' : undefined}
              className={fieldClass}
              data-testid="palette-item-input"
            />
            <Button type="submit" data-testid="palette-item-add">Add</Button>
          </div>
          {error && <p id="palette-item-error" className="mt-1 text-sm text-destructive">{error}</p>}
          {choices.length > 1 ? (
            <div className="mt-3">
              <p id="palette-item-list-label" className="mb-1 text-sm text-muted-foreground">Add to</p>
              <div role="radiogroup" aria-labelledby="palette-item-list-label" className="flex flex-wrap gap-2" data-testid="palette-item-lists">
                {choices.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="radio"
                    aria-checked={candidate.id === list?.id}
                    onClick={() => setListId(candidate.id)}
                    className={cn(
                      'inline-flex min-h-[var(--target-min)] items-center rounded-full border px-4 text-sm font-medium transition-ui',
                      candidate.id === list?.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
                    )}
                  >
                    {candidate.name}
                  </button>
                ))}
              </div>
            </div>
          ) : list ? (
            <p className="mt-2 text-sm text-muted-foreground">Adds to {list.name}.</p>
          ) : null}
        </form>
      ) : state.status === 'loading' ? (
        <Notice>Loading your lists…</Notice>
      ) : state.status === 'empty' ? (
        <div>
          <Notice>{state.message}</Notice>
          <Button type="button" variant="outline" className="mt-2" onClick={onOpenShopping}>Open Shopping</Button>
        </div>
      ) : (
        <Notice tone={state.status === 'failed' ? 'error' : 'muted'} onRetry={state.status === 'failed' ? onRetry : undefined}>{state.message}</Notice>
      )}
    </ModeShell>
  );
}

/** Chore mode: what needs doing ("vacuum Friday for Sam"), then the usual preview. */
export function ChoreMode({
  blocker,
  context,
  loading,
  text,
  onText,
  onPreview,
  onTypeInstead,
}: {
  blocker: string | null;
  context: QuickAddContext | null;
  /** The palette index (members, rooms) is still loading. */
  loading: boolean;
  text: string;
  onText: (text: string) => void;
  onPreview: (intent: ChoreIntent) => void;
  onTypeInstead: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!context || loading) return;
    const intent = choreModeIntent(text, { ...context, now: new Date() });
    if (!intent) {
      setError('Type what needs doing, like “vacuum Friday for Sam”.');
      return;
    }
    onPreview(intent);
  };
  return (
    <ModeShell mode="chore" onTypeInstead={onTypeInstead}>
      {blocker ? <Notice>{blocker}</Notice> : (
        <form onSubmit={submit} noValidate>
          <label htmlFor="palette-chore-text" className="mb-1 block text-sm text-muted-foreground">What needs doing?</label>
          <div className="flex gap-2">
            <input
              id="palette-chore-text"
              autoFocus
              value={text}
              onChange={(event) => {
                onText(event.target.value);
                setError(null);
              }}
              enterKeyHint="next"
              autoComplete="off"
              placeholder="vacuum Friday for Sam"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'palette-chore-error' : undefined}
              className={fieldClass}
              data-testid="palette-chore-input"
            />
            <Button type="submit" disabled={loading || !context} data-testid="palette-chore-next">
              {loading && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Next
            </Button>
          </div>
          {error && <p id="palette-chore-error" className="mt-1 text-sm text-destructive">{error}</p>}
        </form>
      )}
    </ModeShell>
  );
}
