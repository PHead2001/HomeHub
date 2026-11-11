'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { toast } from '@/hooks/use-toast';
import { MAX_QUICK_ADD_ITEMS, mergeRetryText, parseQuickAdd, quickAddFailureMessage, type QuickAddEntry } from '@/lib/shopping/items';
import { failedEntries, notAddedNotice, type QuickAddOutcome } from '@/lib/shopping/quick-add-outcome';

export type { QuickAddOutcome };

type PendingChip = { id: number; names: string; label: string };

/**
 * The inline quick-add field pinned to the bottom of an open list (H07). It takes
 * one or several items in one go ("milk, eggs, 2 bread"); duplicates merge into
 * the existing needed item.
 *
 * Contract:
 * - Submitting parses the text into entries and clears the field at once. Those
 *   entries are the submission; anything typed afterwards is new input.
 * - While a save runs, another submit is ignored (the text stays in the field) and
 *   the button shows a spinner; Enter on an empty field shows an inline hint only
 *   when nothing is saving.
 * - When the save finishes, entries that failed are put back in front of whatever
 *   is in the field now, with an inline message naming them; on full success the
 *   field is left as the member has it. Saved entries are never put back.
 * - The wait is bounded (SH-4c): entries the save could not confirm in time leave
 *   the spinner and show in a "Still sending…" / "Checking…" chip under the field,
 *   so further adds work at once. When they settle, the chip goes; entries that
 *   finally failed are put back into the field with the inline message (Retry =
 *   press Add), so typed input is never lost and nothing is added twice.
 * - Focus stays in the field. Mount it with a key per list: if it unmounts while
 *   saving (another list or page was opened), failed entries are reported in a
 *   toast instead, since there is no field to put them back into.
 *
 * The Undo snackbar (SH-15a) is passed as `above` and drawn in the same sticky
 * dock, directly above the field (outside the form).
 */
export function QuickAddBar({ listName, onAdd, above }: { listName: string; onAdd: (entries: QuickAddEntry[]) => Promise<QuickAddOutcome>; above?: ReactNode }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chips, setChips] = useState<PendingChip[]>([]);
  const busyRef = useRef(false);
  const chipIdRef = useRef(0);
  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldId = `quick-add-${useId().replace(/:/g, '')}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    // One save at a time; the ref also blocks a second Enter before re-render.
    if (busyRef.current) return;
    const entries = parseQuickAdd(value);
    if (entries.length === 0) {
      setError('Type an item, or several separated by commas.');
      inputRef.current?.focus();
      return;
    }
    // The submitted entries are a snapshot; the field is free for new input.
    setValue('');
    setError(null);
    busyRef.current = true;
    setBusy(true);
    let failed: QuickAddEntry[] = entries;
    try {
      const outcome = await onAdd(entries);
      failed = failedEntries(outcome, entries);
      if (outcome?.pending) trackPending(outcome.pending);
    } catch {
      failed = entries;
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setValue((current) => mergeRetryText(failed, current));
        setError(quickAddFailureMessage(failed));
        inputRef.current?.focus();
      } else {
        const notice = notAddedNotice(listName, failed);
        if (notice) toast(notice);
      }
    }
  };

  // Entries still waiting for an answer: a chip until they settle; late failures
  // go back into the field like any failure.
  const trackPending = (pending: NonNullable<QuickAddOutcome>['pending'] & object) => {
    chipIdRef.current += 1;
    const id = chipIdRef.current;
    setChips((current) => [...current, { id, names: pending.entries.map((entry) => entry.name).join(', '), label: pending.label }]);
    void pending.settled.catch(() => pending.entries).then((lateFailed) => {
      if (!mountedRef.current) {
        const notice = notAddedNotice(listName, lateFailed);
        if (notice) toast(notice);
        return;
      }
      setChips((current) => current.filter((chip) => chip.id !== id));
      if (lateFailed.length > 0) {
        setValue((current) => mergeRetryText(lateFailed, current));
        setError(quickAddFailureMessage(lateFailed));
      }
    });
  };

  return (
    <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 -mx-2 mt-4 space-y-2 md:bottom-2">
    {above}
    <form
      onSubmit={submit}
      className="surface-glass rounded-xl border p-2 shadow-overlay"
      aria-label={`Quick add to ${listName}`}
      aria-busy={busy}
    >
      <label htmlFor={fieldId} className="sr-only">Items to add to {listName}</label>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          placeholder="milk, eggs, 2 bread"
          autoComplete="off"
          enterKeyHint="done"
          maxLength={MAX_QUICK_ADD_ITEMS * 40}
          className="h-11 flex-1 [@media(pointer:coarse)]:h-12"
          {...fieldErrorProps(fieldId, error)}
        />
        <Button type="submit" disabled={busy} aria-label={`Add to ${listName}`} className="h-11 min-w-11 shrink-0 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:min-w-12">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          <span className="ml-1 hidden sm:inline">Add</span>
        </Button>
      </div>
      <FieldError id={fieldId} className="mt-1.5 px-1">{error}</FieldError>
      {chips.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5 px-1" role="status" aria-live="polite" data-testid="quick-add-pending">
          {chips.map((chip) => (
            <li key={chip.id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              <span>{chip.label} {chip.names}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
    </div>
  );
}
