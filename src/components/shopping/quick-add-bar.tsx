'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { toast } from '@/hooks/use-toast';
import { MAX_QUICK_ADD_ITEMS, mergeRetryText, parseQuickAdd, quickAddFailureMessage, type QuickAddEntry } from '@/lib/shopping/items';

/**
 * What happened to a quick-add submission: `failed` are the entries that could not
 * be saved (the others were). `null` means nothing was saved, so every submitted
 * entry counts as failed.
 */
export type QuickAddOutcome = { failed: QuickAddEntry[] } | null;

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
 * - Focus stays in the field. Mount it with a key per list: if it unmounts while
 *   saving (another list or page was opened), failed entries are reported in a
 *   toast instead, since there is no field to put them back into.
 * - Offline, entries are queued by Firestore and count as saved.
 */
export function QuickAddBar({ listName, onAdd }: { listName: string; onAdd: (entries: QuickAddEntry[]) => Promise<QuickAddOutcome> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
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
      failed = outcome ? outcome.failed : entries;
    } catch {
      failed = entries;
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setBusy(false);
        setValue((current) => mergeRetryText(failed, current));
        setError(quickAddFailureMessage(failed));
        inputRef.current?.focus();
      } else if (failed.length > 0) {
        toast({ variant: 'destructive', title: `Not added to ${listName}`, description: failed.map((entry) => entry.name).join(', ') });
      }
    }
  };

  return (
    <form
      onSubmit={submit}
      className="surface-glass sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 -mx-2 mt-4 rounded-xl border p-2 shadow-overlay md:bottom-2"
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
          className="flex-1"
          {...fieldErrorProps(fieldId, error)}
        />
        <Button type="submit" disabled={busy} aria-label={`Add to ${listName}`} className="shrink-0">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          <span className="ml-1 hidden sm:inline">Add</span>
        </Button>
      </div>
      <FieldError id={fieldId} className="mt-1.5 px-1">{error}</FieldError>
    </form>
  );
}
