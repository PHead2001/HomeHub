'use client';

import * as React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { NumberTicker } from '@/components/motion/number-ticker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { presentFields } from '@/lib/maintenance/display';
import { cn } from '@/lib/utils';
import type { SaveNoticeState } from './page-model';

/** A dialog's offline or no-answer note; Retry resends the same request (same op id). */
export function SaveNotice({ notice, busy }: { notice?: SaveNoticeState; busy: boolean }) {
  if (!notice) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-6 py-3 text-sm">
      <span className="min-w-0 flex-1">{notice.message}</span>
      {notice.retry && (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={notice.retry}>
          {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
          Retry
        </Button>
      )}
    </div>
  );
}

/** The one-time warning before saving an unusual odometer reading. */
export function MileageWarning({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground sm:col-span-2">{message}</p>;
}

export function SummaryCard({
  title,
  value,
  format,
  detail,
  icon: Icon,
}: {
  title: string;
  /** A count or amount: rendered as a NumberTicker (H12). */
  value: number;
  /** Intl options for the value, e.g. currency. */
  format?: Intl.NumberFormatOptions;
  detail: string;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold"><NumberTicker value={value} format={format} /></div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

/** Detail fields that have a value; empty ones are left out instead of saying "Not recorded" (D15). */
export function DetailGrid({ fields }: { fields: Array<{ label: string; value?: string | number | null }> }) {
  const present = presentFields(fields);
  if (present.length === 0) return null;
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {present.map((field) => (
        <div key={field.label}>
          <dt className="text-xs uppercase text-muted-foreground">{field.label}</dt>
          <dd className="text-sm">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const AutoResizeTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentPropsWithoutRef<typeof Textarea>
>(({ className, onInput, value, ...props }, forwardedRef) => {
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  const resizeTextarea = useCallback((textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  React.useImperativeHandle(forwardedRef, () => localRef.current as HTMLTextAreaElement);

  useEffect(() => {
    if (localRef.current) {
      resizeTextarea(localRef.current);
    }
  }, [resizeTextarea, value]);

  return (
    <Textarea
      {...props}
      ref={localRef}
      value={value}
      className={cn('min-h-24 resize-none overflow-hidden', className)}
      onInput={(event) => {
        resizeTextarea(event.currentTarget);
        onInput?.(event);
      }}
    />
  );
});
AutoResizeTextarea.displayName = 'AutoResizeTextarea';

/** Moves focus to the first schedule row with a problem (its name field) on submit. */
export function focusScheduleField(kind: 'asset' | 'vehicle', scheduleId?: string) {
  if (!scheduleId) return;
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-schedule-name="${kind}-${CSS.escape(scheduleId)}"]`)?.focus());
}
