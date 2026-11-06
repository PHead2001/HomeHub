'use client';

import { useId, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { MAX_QUICK_ADD_ITEMS, parseQuickAdd, type QuickAddEntry } from '@/lib/shopping/items';

/**
 * The inline quick-add field pinned to the bottom of an open list (H07). It takes
 * one or several items in one go ("milk, eggs, 2 bread"); duplicates merge into
 * the existing needed item. The field keeps focus after each add so a member can
 * keep typing. Problems are shown inline under the field.
 */
export function QuickAddBar({ listName, onAdd }: { listName: string; onAdd: (entries: QuickAddEntry[]) => Promise<boolean> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldId = `quick-add-${useId().replace(/:/g, '')}`;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const entries = parseQuickAdd(value);
    if (entries.length === 0) {
      setError('Type an item, or several separated by commas.');
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const ok = await onAdd(entries);
      if (ok) setValue('');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="surface-glass sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 -mx-2 mt-4 rounded-xl border p-2 shadow-overlay md:bottom-2"
      aria-label={`Quick add to ${listName}`}
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
