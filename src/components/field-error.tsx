'use client';

import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fieldErrorId } from '@/lib/field-errors';

export { fieldErrorId, fieldErrorProps } from '@/lib/field-errors';

/**
 * Validation rule (one pattern for every form):
 * - A problem with a field (missing, too long, bad date) is shown inline, right
 *   under that field, with `FieldError` (or `FormMessage` inside react-hook-form
 *   forms, which looks the same). The field gets `aria-invalid` and
 *   `aria-describedby` pointing at the message; focus moves to the first invalid
 *   field on submit. Never toast a field problem: the toast would sit away from
 *   the field and disappear before it is fixed.
 * - Toasts are only for outcomes: "Saved", "Deleted", or a failure to reach the
 *   server (pass the caught error to `toastError` so the text is plain language).
 *
 *   const nameError = !name.trim() ? 'Give the list a name.' : null;
 *   <Input id="list-name" {...fieldErrorProps('list-name', submitted && nameError)} />
 *   <FieldError id="list-name">{submitted && nameError}</FieldError>
 */

export type FieldErrorProps = Omit<React.HTMLAttributes<HTMLParagraphElement>, 'id'> & {
  /** The field's id; the message gets `${id}-error`. */
  id: string;
  children?: React.ReactNode | false | null;
};

/**
 * Inline field message. Renders nothing when there is no error; the message is
 * announced (`role="alert"`) when it appears.
 */
export const FieldError = React.forwardRef<HTMLParagraphElement, FieldErrorProps>(function FieldError(
  { id, children, className, ...props },
  ref,
) {
  if (children === null || children === undefined || children === false || children === '') return null;
  return (
    <p
      ref={ref}
      id={fieldErrorId(id)}
      role="alert"
      className={cn('flex items-start gap-1.5 text-sm font-medium text-destructive', className)}
      {...props}
    >
      <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
});
